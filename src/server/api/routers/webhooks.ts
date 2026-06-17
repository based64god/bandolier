import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { cleanSessionToken, validateAwsCredentials } from "~/server/agents/aws";
import { validateAnthropicKey } from "~/server/agents/anthropic";
import {
  summarizeGeminiCredentials,
  validateGeminiCredentials,
} from "~/server/agents/gemini";
import { getUserGithubToken } from "~/server/agents/github-token";
import { validateOpenaiKey } from "~/server/agents/openai";
import { validateKubeconfig } from "~/server/agents/kubeconfig";
import { canManageWebhooks } from "~/server/agents/webhook-config";
import { type db } from "~/server/db";
import { repoWebhookConfig } from "~/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Upserts a partial set of columns onto a repo's config row, stamping who made
 * the change. Used by the credential mutations so each one can set just its own
 * fields without clobbering the rest.
 */
async function upsertRepoConfig(
  database: typeof db,
  repoFullName: string,
  userId: string,
  values: Partial<typeof repoWebhookConfig.$inferInsert>,
): Promise<void> {
  await database
    .insert(repoWebhookConfig)
    .values({ repoFullName, configuredBy: userId, ...values })
    .onConflictDoUpdate({
      target: repoWebhookConfig.repoFullName,
      set: { ...values, configuredBy: userId, updatedAt: new Date() },
    });
}

/**
 * Loads the user's GitHub token and confirms they have admin on the repo —
 * required to view or change incoming-webhook configuration. Throws otherwise.
 */
async function requireRepoAdmin(
  ctx: {
    db: Parameters<typeof getUserGithubToken>[0];
    session: { user: { id: string } };
  },
  repoFullName: string,
): Promise<void> {
  const token = await getUserGithubToken(ctx.db, ctx.session.user.id);
  if (!token) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "A linked GitHub account is required.",
    });
  }
  if (!(await canManageWebhooks(token, repoFullName))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "You need admin permission on this repository to manage webhooks.",
    });
  }
}

export const webhooksRouter = createTRPCRouter({
  // Non-secret status of a repo's incoming-webhook config.
  getConfig: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const [row] = await ctx.db
        .select({
          updatedAt: repoWebhookConfig.updatedAt,
          prefix: repoWebhookConfig.prefix,
          secret: repoWebhookConfig.secret,
          agentImage: repoWebhookConfig.agentImage,
          defaultWebhookModel: repoWebhookConfig.defaultWebhookModel,
        })
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
        .limit(1);
      return {
        // Whether a config row exists at all (any setting saved).
        configured: !!row,
        // Whether a per-repo webhook secret is set (separate from other config).
        hasSecret: !!row?.secret,
        updatedAt: row?.updatedAt ?? null,
        prefix: row?.prefix ?? "",
        agentImage: row?.agentImage ?? "",
        defaultWebhookModel: row?.defaultWebhookModel ?? null,
      };
    }),

  setConfig: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Optional: when a row already exists, omitting keeps the current secret.
        secret: z.string().optional(),
        // Optional trigger phrase; blank clears it (act on all events).
        prefix: z.string().optional(),
        // Optional agent harness image override; blank clears it (use default).
        agentImage: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);

      const [existing] = await ctx.db
        .select({ repoFullName: repoWebhookConfig.repoFullName })
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
        .limit(1);

      const secret = input.secret?.trim();
      if (secret && secret.length < 8) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Use a secret of at least 8 characters.",
        });
      }

      const prefix = input.prefix?.trim() ? input.prefix.trim() : null;
      const agentImage = input.agentImage?.trim()
        ? input.agentImage.trim()
        : null;

      if (existing) {
        await ctx.db
          .update(repoWebhookConfig)
          .set({
            prefix,
            agentImage,
            configuredBy: ctx.session.user.id,
            updatedAt: new Date(),
            ...(secret ? { secret } : {}),
          })
          .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      } else {
        await ctx.db.insert(repoWebhookConfig).values({
          repoFullName: input.repoFullName,
          secret: secret ?? null,
          prefix,
          agentImage,
          configuredBy: ctx.session.user.id,
        });
      }
      return { success: true };
    }),

  // Clears the per-repo webhook secret only. The config row also carries shared
  // credentials (kubeconfig, model keys, AWS), the default webhook model, and the
  // prefer flag, so it is never deleted here — only the secret is nulled — to
  // avoid wiping that other config as collateral.
  deleteConfig: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);

      await ctx.db
        .update(repoWebhookConfig)
        .set({
          secret: null,
          configuredBy: ctx.session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      return { success: true };
    }),

  // Set (or clear, with an empty string) the default model for webhook-triggered
  // agents. Partial upsert so it doesn't clobber other webhook config. Not
  // validated against the live model list here — selection re-checks availability
  // at trigger time and falls back to the provider default.
  setDefaultModel: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        model: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const value = input.model.trim() ? input.model.trim() : null;
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        defaultWebhookModel: value,
      });
      return { success: true };
    }),

  // ── Repo-scoped credentials (admin-only) ────────────────────────────────────
  // Shared kubeconfig + model credentials for everyone working on the repo. All
  // procedures require repo admin. SECURITY: these are shared infrastructure —
  // the UI warns admins to scope the cluster/keys to what the whole group should
  // be trusted with. Secrets are never returned to the client; only masked
  // status is.

  // Non-secret status of a repo's shared credentials plus the prefer toggle.
  getCredentials: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const [row] = await ctx.db
        .select({
          kubeconfig: repoWebhookConfig.kubeconfig,
          anthropicApiKey: repoWebhookConfig.anthropicApiKey,
          openaiApiKey: repoWebhookConfig.openaiApiKey,
          geminiApiKey: repoWebhookConfig.geminiApiKey,
          awsAccessKeyId: repoWebhookConfig.awsAccessKeyId,
          awsSecretAccessKey: repoWebhookConfig.awsSecretAccessKey,
          awsSessionToken: repoWebhookConfig.awsSessionToken,
          awsRegion: repoWebhookConfig.awsRegion,
          preferRepoCredentials: repoWebhookConfig.preferRepoCredentials,
        })
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
        .limit(1);
      const hasAws = !!row?.awsAccessKeyId && !!row.awsSecretAccessKey;
      return {
        hasKubeconfig: !!row?.kubeconfig,
        anthropic: row?.anthropicApiKey
          ? {
              configured: true as const,
              apiKeyMasked: maskKey(row.anthropicApiKey),
            }
          : { configured: false as const },
        openai: row?.openaiApiKey
          ? {
              configured: true as const,
              apiKeyMasked: maskKey(row.openaiApiKey),
            }
          : { configured: false as const },
        gemini: row?.geminiApiKey
          ? {
              configured: true as const,
              ...summarizeGeminiCredentials(row.geminiApiKey),
            }
          : { configured: false as const },
        aws: hasAws
          ? {
              configured: true as const,
              accessKeyIdMasked: maskKey(row.awsAccessKeyId!),
              region: row.awsRegion ?? "us-east-1",
              isTemporary: !!row.awsSessionToken,
            }
          : { configured: false as const },
        preferRepoCredentials: row?.preferRepoCredentials ?? false,
      };
    }),

  // Validate then store a repo-scoped kubeconfig.
  setKubeconfig: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        kubeconfig: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const validation = await validateKubeconfig(input.kubeconfig);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Kubeconfig is invalid.",
        });
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        kubeconfig: input.kubeconfig,
      });
      return { valid: true as const, version: validation.version };
    }),

  deleteKubeconfig: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .update(repoWebhookConfig)
        .set({
          kubeconfig: null,
          configuredBy: ctx.session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      return { success: true };
    }),

  // Validate then store a repo-scoped Anthropic API key.
  setAnthropic: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        apiKey: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const validation = await validateAnthropicKey(input.apiKey);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Anthropic API key is invalid.",
        });
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        anthropicApiKey: input.apiKey,
      });
      return { valid: true as const };
    }),

  deleteAnthropic: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .update(repoWebhookConfig)
        .set({
          anthropicApiKey: null,
          configuredBy: ctx.session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      return { success: true };
    }),

  // Validate then store a repo-scoped OpenAI API key (used via the Codex CLI).
  setOpenai: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        apiKey: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const validation = await validateOpenaiKey(input.apiKey);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "OpenAI API key is invalid.",
        });
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        openaiApiKey: input.apiKey,
      });
      return { valid: true as const };
    }),

  deleteOpenai: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .update(repoWebhookConfig)
        .set({
          openaiApiKey: null,
          configuredBy: ctx.session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      return { success: true };
    }),

  // Validate then store repo-scoped Gemini project credentials (a Google Cloud
  // service-account key JSON, used via the Antigravity CLI).
  setGemini: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        credentials: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const validation = await validateGeminiCredentials(input.credentials);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Gemini credentials are invalid.",
        });
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        geminiApiKey: input.credentials,
      });
      return { valid: true as const };
    }),

  deleteGemini: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .update(repoWebhookConfig)
        .set({
          geminiApiKey: null,
          configuredBy: ctx.session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      return { success: true };
    }),

  // Validate then store repo-scoped AWS Bedrock credentials.
  setAws: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        accessKeyId: z.string().trim().min(16),
        secretAccessKey: z.string().trim().min(1),
        sessionToken: z.string().optional().transform(cleanSessionToken),
        region: z.string().trim().min(1).default("us-east-1"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const validation = await validateAwsCredentials({
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        sessionToken: input.sessionToken,
        region: input.region,
      });
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "AWS credentials are invalid.",
        });
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        awsAccessKeyId: input.accessKeyId,
        awsSecretAccessKey: input.secretAccessKey,
        awsSessionToken: input.sessionToken ?? null,
        awsRegion: input.region,
      });
      return { valid: true as const, arn: validation.arn };
    }),

  deleteAws: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .update(repoWebhookConfig)
        .set({
          awsAccessKeyId: null,
          awsSecretAccessKey: null,
          awsSessionToken: null,
          awsRegion: null,
          configuredBy: ctx.session.user.id,
          updatedAt: new Date(),
        })
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      return { success: true };
    }),

  // Toggle whether the repo's shared credentials win over a user's own when both
  // are set (applies to kubeconfig and model credentials alike).
  setPreferRepoCredentials: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        prefer: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        preferRepoCredentials: input.prefer,
      });
      return { success: true };
    }),
});
