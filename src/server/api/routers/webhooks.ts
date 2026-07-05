import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { cleanSessionToken, validateAwsCredentials } from "~/server/agents/aws";
import { validateAnthropicKey } from "~/server/agents/anthropic";
import {
  summarizeGeminiCredentials,
  validateGeminiCredentials,
} from "~/server/agents/gemini";
import { validateArtifactStore } from "~/server/agents/artifacts";
import { getUserGithubToken } from "~/server/agents/github-token";
import { validateOpenaiKey } from "~/server/agents/openai";
import { validateKubeconfig } from "~/server/agents/kubeconfig";
import { repoToNamespace } from "~/server/agents/namespace";
import {
  renderDefaultNetworkPolicyYaml,
  validateNetworkPolicyYaml,
} from "~/server/agents/network-policy";
import { isRepoAdmin } from "~/server/agents/webhook-config";
import { validateCpuQuantity, validateMemoryQuantity } from "~/lib/compute";
import { EFFORT_LEVELS } from "~/lib/effort";
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
 * required to view or change repo-scoped configuration. Throws otherwise.
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
  if (!(await isRepoAdmin(token, repoFullName))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "You need admin permission on this repository to change its configuration.",
    });
  }
}

export const webhooksRouter = createTRPCRouter({
  // Non-secret status of a repo's webhook/agent configuration.
  getConfig: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const [row] = await ctx.db
        .select({
          updatedAt: repoWebhookConfig.updatedAt,
          prefix: repoWebhookConfig.prefix,
          agentImage: repoWebhookConfig.agentImage,
          defaultWebhookModel: repoWebhookConfig.defaultWebhookModel,
          defaultWebhookEffort: repoWebhookConfig.defaultWebhookEffort,
          computeCpu: repoWebhookConfig.computeCpu,
          computeMemory: repoWebhookConfig.computeMemory,
          systemPrompt: repoWebhookConfig.systemPrompt,
          resumeOnCiFailure: repoWebhookConfig.resumeOnCiFailure,
          allowPrivateEgress: repoWebhookConfig.allowPrivateEgress,
          allowAllPortsEgress: repoWebhookConfig.allowAllPortsEgress,
          networkPolicyYaml: repoWebhookConfig.networkPolicyYaml,
        })
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
        .limit(1);
      const allowPrivateEgress = row?.allowPrivateEgress ?? false;
      const allowAllPortsEgress = row?.allowAllPortsEgress ?? false;
      return {
        // Whether a config row exists at all (any setting saved).
        configured: !!row,
        updatedAt: row?.updatedAt ?? null,
        prefix: row?.prefix ?? "",
        agentImage: row?.agentImage ?? "",
        defaultWebhookModel: row?.defaultWebhookModel ?? null,
        defaultWebhookEffort: row?.defaultWebhookEffort ?? null,
        // Default agent compute for the repo ("" = none; fall through to the
        // user default, then the built-in limit).
        computeCpu: row?.computeCpu ?? "",
        computeMemory: row?.computeMemory ?? "",
        systemPrompt: row?.systemPrompt ?? "",
        // Whether a failing CI pipeline auto-resumes the run that produced the
        // PR (off unless a row turns it on).
        resumeOnCiFailure: row?.resumeOnCiFailure ?? false,
        // Network-policy egress toggles (both off unless a row turns them on).
        allowPrivateEgress,
        allowAllPortsEgress,
        // Advanced: the repo's custom NetworkPolicy YAML ("" = none), plus the
        // policy the toggles would otherwise produce — the starting point the
        // UI seeds the raw-YAML editor with.
        networkPolicyYaml: row?.networkPolicyYaml ?? "",
        defaultNetworkPolicyYaml: renderDefaultNetworkPolicyYaml(
          repoToNamespace(input.repoFullName),
          { allowPrivateEgress, allowAllPortsEgress },
        ),
      };
    }),

  // Set the per-repo network-policy egress toggles. Both loosen the default
  // agent NetworkPolicy and are admin-only. SECURITY: enabling either trades
  // pod isolation for reach — the repo-config UI surfaces a warning. Partial
  // upsert so each toggle can be set without clobbering other config.
  setNetworkPolicy: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Allow egress to private / in-cluster (RFC-1918) ranges.
        allowPrivateEgress: z.boolean().optional(),
        // Allow egress on any TCP port instead of only 80/443.
        allowAllPortsEgress: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const values: Partial<typeof repoWebhookConfig.$inferInsert> = {};
      if (input.allowPrivateEgress !== undefined) {
        values.allowPrivateEgress = input.allowPrivateEgress;
      }
      if (input.allowAllPortsEgress !== undefined) {
        values.allowAllPortsEgress = input.allowAllPortsEgress;
      }
      await upsertRepoConfig(
        ctx.db,
        input.repoFullName,
        ctx.session.user.id,
        values,
      );
      return { success: true };
    }),

  // Set (or clear, with a blank string) the repo's custom NetworkPolicy YAML —
  // the advanced escape hatch that replaces the built-in agent policy (and the
  // egress toggles) entirely. Admin-only and validated structurally before it's
  // stored, so a broken policy is rejected at save time rather than failing
  // every subsequent deploy. SECURITY: a custom policy can open any egress the
  // cluster allows — the UI surfaces the same isolation warning as the toggles.
  setNetworkPolicyYaml: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Capped like the system prompt so a pathological document can't bloat
        // the config row; real policies are a few hundred bytes.
        yaml: z.string().max(20000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const yaml = input.yaml.trim() ? input.yaml : null;
      if (yaml) {
        const validation = validateNetworkPolicyYaml(yaml);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: validation.error,
          });
        }
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        networkPolicyYaml: yaml,
      });
      return { success: true };
    }),

  setConfig: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Optional trigger phrase; blank clears it (act on all events).
        prefix: z.string().optional(),
        // Optional agent harness image override; blank clears it (use default).
        agentImage: z.string().optional(),
        // Optional repo-attached system prompt: a blanket instruction appended to
        // the system prompt of every agent run for the repo, across dashboard,
        // issue, and webhook runs. Capped to keep it from bloating every job's
        // env; blank clears it.
        systemPrompt: z.string().max(10000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);

      const prefix = input.prefix?.trim() ? input.prefix.trim() : null;
      const agentImage = input.agentImage?.trim()
        ? input.agentImage.trim()
        : null;
      const systemPrompt = input.systemPrompt?.trim()
        ? input.systemPrompt.trim()
        : null;

      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        prefix,
        agentImage,
        systemPrompt,
      });
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

  // Set (or clear, with an empty string) the default reasoning-effort level for
  // webhook-triggered Claude agents. Validated against the known levels; an
  // issue's `effort:<level>` label overrides it per issue, and it's ignored for
  // non-Claude providers. Partial upsert so it doesn't clobber other config.
  setDefaultEffort: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Empty string clears the default (fall back to the CLI default).
        effort: z.union([z.enum(EFFORT_LEVELS), z.literal("")]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const value = input.effort ? input.effort : null;
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        defaultWebhookEffort: value,
      });
      return { success: true };
    }),

  // Toggle whether a failing CI pipeline auto-resumes the run that produced the
  // pull request it ran on (resumeable tasks). Admin-only; off by default since
  // it spends the run owner's credentials without a human in the loop. Partial
  // upsert so it doesn't clobber other config.
  setResumeOnCiFailure: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        resumeOnCiFailure: input.enabled,
      });
      return { success: true };
    }),

  // Set (or clear, with blank strings) the repo's default agent compute (CPU /
  // memory limit), applied to every run for the repo unless a per-task
  // override (deploy form, or an issue's `cpu:`/`memory:` label) or a
  // preferred user default wins. Validated as Kubernetes quantities; partial
  // upsert so it doesn't clobber other config.
  setDefaultCompute: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        cpu: z.string(),
        memory: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      let cpu: string | null = null;
      if (input.cpu.trim()) {
        const v = validateCpuQuantity(input.cpu);
        if (!v.valid) {
          throw new TRPCError({ code: "BAD_REQUEST", message: v.error });
        }
        cpu = v.normalized;
      }
      let memory: string | null = null;
      if (input.memory.trim()) {
        const v = validateMemoryQuantity(input.memory);
        if (!v.valid) {
          throw new TRPCError({ code: "BAD_REQUEST", message: v.error });
        }
        memory = v.normalized;
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        computeCpu: cpu,
        computeMemory: memory,
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
          artifactsS3Bucket: repoWebhookConfig.artifactsS3Bucket,
          artifactsS3Region: repoWebhookConfig.artifactsS3Region,
          artifactsS3Endpoint: repoWebhookConfig.artifactsS3Endpoint,
          artifactsAccessKeyId: repoWebhookConfig.artifactsAccessKeyId,
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
        artifacts: row?.artifactsS3Bucket
          ? {
              configured: true as const,
              bucket: row.artifactsS3Bucket,
              region: row.artifactsS3Region ?? "us-east-1",
              endpoint: row.artifactsS3Endpoint,
              accessKeyIdMasked: row.artifactsAccessKeyId
                ? maskKey(row.artifactsAccessKeyId)
                : null,
            }
          : { configured: false as const },
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

  // Validate then store the repo's run-artifact store (an S3 bucket the repo
  // owns). This is the only place run transcripts (and, later, historical
  // context) can be persisted — there is deliberately no server-wide bucket —
  // so run data always lands in storage the repo controls. Credentials are
  // required — the server has no business reaching a repo-owned bucket through
  // its own ambient credentials — and should be scoped to just this bucket.
  // They stay server-side; they are never injected into agent pods.
  setArtifacts: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        bucket: z.string().trim().min(1),
        region: z.string().trim().min(1).default("us-east-1"),
        // Custom endpoint for MinIO / S3-compatible stores; blank = AWS S3.
        endpoint: z.string().trim().optional(),
        accessKeyId: z.string().trim().min(1),
        secretAccessKey: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      // Blank endpoint means AWS S3 proper, not an empty custom endpoint.
      const endpoint = input.endpoint === "" ? undefined : input.endpoint;
      const validation = await validateArtifactStore({
        bucket: input.bucket,
        region: input.region,
        endpoint,
        credentials: {
          accessKeyId: input.accessKeyId,
          secretAccessKey: input.secretAccessKey,
        },
      });
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Artifact storage is unreachable.",
        });
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        artifactsS3Bucket: input.bucket,
        artifactsS3Region: input.region,
        artifactsS3Endpoint: endpoint ?? null,
        artifactsAccessKeyId: input.accessKeyId,
        artifactsSecretAccessKey: input.secretAccessKey,
      });
      return { valid: true as const };
    }),

  // Clear the repo's artifact store. Already-uploaded artifacts stay in the
  // repo's bucket (they're the repo's data); future runs are simply not
  // persisted until a new bucket is configured.
  deleteArtifacts: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .update(repoWebhookConfig)
        .set({
          artifactsS3Bucket: null,
          artifactsS3Region: null,
          artifactsS3Endpoint: null,
          artifactsAccessKeyId: null,
          artifactsSecretAccessKey: null,
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
