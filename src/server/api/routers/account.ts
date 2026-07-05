import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  getUserAnthropicCredentials,
  validateAnthropicKey,
  validateAnthropicOauthToken,
} from "~/server/agents/anthropic";
import { cleanSessionToken, validateAwsCredentials } from "~/server/agents/aws";
import { getUserCompute, parseComputeInput } from "~/server/agents/compute";
import { maskKey, stripWhitespace } from "~/server/api/credentials";
import {
  getUserKubeconfig,
  resolveKubeconfig,
  validateKubeconfig,
} from "~/server/agents/kubeconfig";
import {
  getUserGeminiKey,
  summarizeGeminiCredentials,
  validateGeminiCredentials,
} from "~/server/agents/gemini";
import {
  getUserOpenaiCredentials,
  validateCodexAuthJson,
  validateOpenaiKey,
} from "~/server/agents/openai";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import {
  userAnthropicCredentials,
  userAwsCredentials,
  userCompute,
  userGeminiCredentials,
  userKubeconfig,
  userOpenaiCredentials,
} from "~/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const accountRouter = createTRPCRouter({
  // Returns non-secret info about the user's stored AWS credentials.
  awsStatus: protectedProcedure.query(async ({ ctx }) => {
    const creds = await getUserAwsCredentials(ctx.db, ctx.session.user.id);
    if (!creds) return { configured: false as const };
    return {
      configured: true as const,
      accessKeyIdMasked: maskKey(creds.accessKeyId),
      region: creds.region,
      isTemporary: !!creds.sessionToken,
    };
  }),

  // Validates the currently stored credentials (e.g. to check for expiry).
  testAws: protectedProcedure.mutation(async ({ ctx }) => {
    const creds = await getUserAwsCredentials(ctx.db, ctx.session.user.id);
    if (!creds) {
      return { valid: false as const, error: "No credentials configured." };
    }
    return validateAwsCredentials(creds);
  }),

  // Validates then stores (upserts) AWS credentials for the user.
  setAws: protectedProcedure
    .input(
      z.object({
        // Trim to avoid whitespace from pasted blocks corrupting the signature
        // (AWS reports that as a generic "security token invalid" error).
        accessKeyId: z.string().trim().min(16),
        secretAccessKey: z.string().trim().min(1),
        // Optional: blank / whitespace-only normalizes to undefined so a
        // permanent-credential user is never treated as needing a session token.
        sessionToken: z.string().optional().transform(cleanSessionToken),
        region: z.string().trim().min(1).default("us-east-1"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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

      await ctx.db
        .insert(userAwsCredentials)
        .values({
          userId: ctx.session.user.id,
          accessKeyId: input.accessKeyId,
          secretAccessKey: input.secretAccessKey,
          sessionToken: input.sessionToken ?? null,
          region: input.region,
        })
        .onConflictDoUpdate({
          target: userAwsCredentials.userId,
          set: {
            accessKeyId: input.accessKeyId,
            secretAccessKey: input.secretAccessKey,
            sessionToken: input.sessionToken ?? null,
            region: input.region,
            updatedAt: new Date(),
          },
        });

      return { valid: true as const, arn: validation.arn };
    }),

  deleteAws: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .delete(userAwsCredentials)
      .where(eq(userAwsCredentials.userId, ctx.session.user.id));
    return { success: true };
  }),

  // ── Anthropic credentials (API key or Claude subscription OAuth token) ─────

  // Both credential kinds can be configured at once; the API key takes
  // precedence at run time, and the UI shows each kind separately.
  anthropicStatus: protectedProcedure.query(async ({ ctx }) => {
    const creds = await getUserAnthropicCredentials(
      ctx.db,
      ctx.session.user.id,
    );
    return {
      configured: !!(creds.apiKey ?? creds.oauthToken),
      apiKeyMasked: creds.apiKey ? maskKey(creds.apiKey) : null,
      oauthTokenMasked: creds.oauthToken ? maskKey(creds.oauthToken) : null,
    };
  }),

  testAnthropic: protectedProcedure
    .input(
      z
        .object({ kind: z.enum(["api_key", "oauth_token"]).optional() })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const creds = await getUserAnthropicCredentials(
        ctx.db,
        ctx.session.user.id,
      );
      const kind = input?.kind ?? (creds.apiKey ? "api_key" : "oauth_token");
      if (kind === "oauth_token") {
        // OAuth tokens only work through the Claude Code CLI, so a live API
        // probe isn't possible — re-check the format instead.
        if (!creds.oauthToken)
          return { valid: false as const, error: "No OAuth token configured." };
        return validateAnthropicOauthToken(creds.oauthToken);
      }
      if (!creds.apiKey)
        return { valid: false as const, error: "No API key configured." };
      return validateAnthropicKey(creds.apiKey);
    }),

  setAnthropic: protectedProcedure
    // Strip ALL whitespace, not just the ends: a key copied from a wrapped
    // terminal line arrives with interior spaces/newlines that survive trim().
    .input(z.object({ apiKey: stripWhitespace.pipe(z.string().min(1)) }))
    .mutation(async ({ ctx, input }) => {
      const validation = await validateAnthropicKey(input.apiKey);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Anthropic API key is invalid.",
        });
      }

      // Both kinds can coexist — setting the key leaves any OAuth token alone
      // (the key takes precedence at run time).
      await ctx.db
        .insert(userAnthropicCredentials)
        .values({ userId: ctx.session.user.id, apiKey: input.apiKey })
        .onConflictDoUpdate({
          target: userAnthropicCredentials.userId,
          set: { apiKey: input.apiKey, updatedAt: new Date() },
        });

      return { valid: true as const };
    }),

  setAnthropicOauth: protectedProcedure
    // Strip ALL whitespace, not just the ends: a setup-token copied from a
    // wrapped terminal line arrives with interior spaces that survive trim(),
    // pass the format check, and only fail at run time as the claude CLI's
    // "401 Invalid bearer token" (OAuth tokens can't be probed at save time).
    .input(z.object({ oauthToken: stripWhitespace.pipe(z.string().min(1)) }))
    .mutation(async ({ ctx, input }) => {
      const validation = validateAnthropicOauthToken(input.oauthToken);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "OAuth token is invalid.",
        });
      }

      await ctx.db
        .insert(userAnthropicCredentials)
        .values({
          userId: ctx.session.user.id,
          oauthToken: input.oauthToken,
        })
        .onConflictDoUpdate({
          target: userAnthropicCredentials.userId,
          set: { oauthToken: input.oauthToken, updatedAt: new Date() },
        });

      return { valid: true as const };
    }),

  deleteAnthropic: protectedProcedure
    .input(
      z
        .object({ kind: z.enum(["api_key", "oauth_token"]).optional() })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      if (input?.kind) {
        const creds = await getUserAnthropicCredentials(ctx.db, userId);
        const otherRemains =
          input.kind === "api_key" ? !!creds.oauthToken : !!creds.apiKey;
        if (otherRemains) {
          await ctx.db
            .update(userAnthropicCredentials)
            .set(
              input.kind === "api_key"
                ? { apiKey: null, updatedAt: new Date() }
                : { oauthToken: null, updatedAt: new Date() },
            )
            .where(eq(userAnthropicCredentials.userId, userId));
          return { success: true };
        }
      }
      await ctx.db
        .delete(userAnthropicCredentials)
        .where(eq(userAnthropicCredentials.userId, userId));
      return { success: true };
    }),

  // ── OpenAI credentials (API key or ChatGPT-subscription auth.json) ─────────

  // Both credential kinds can be configured at once; the API key takes
  // precedence at run time, and the UI shows each kind separately.
  openaiStatus: protectedProcedure.query(async ({ ctx }) => {
    const creds = await getUserOpenaiCredentials(ctx.db, ctx.session.user.id);
    return {
      configured: !!(creds.apiKey ?? creds.codexAuthJson),
      apiKeyMasked: creds.apiKey ? maskKey(creds.apiKey) : null,
      chatgptConfigured: !!creds.codexAuthJson,
    };
  }),

  testOpenai: protectedProcedure
    .input(
      z.object({ kind: z.enum(["api_key", "chatgpt"]).optional() }).optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const creds = await getUserOpenaiCredentials(ctx.db, ctx.session.user.id);
      const kind = input?.kind ?? (creds.apiKey ? "api_key" : "chatgpt");
      if (kind === "chatgpt") {
        // ChatGPT session tokens can't be probed against the OpenAI API —
        // re-check the auth.json shape instead.
        if (!creds.codexAuthJson)
          return {
            valid: false as const,
            error: "No ChatGPT auth configured.",
          };
        return validateCodexAuthJson(creds.codexAuthJson);
      }
      if (!creds.apiKey)
        return { valid: false as const, error: "No API key configured." };
      return validateOpenaiKey(creds.apiKey);
    }),

  setOpenai: protectedProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const validation = await validateOpenaiKey(input.apiKey);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "OpenAI API key is invalid.",
        });
      }

      // Both kinds can coexist — setting the key leaves any ChatGPT auth alone
      // (the key takes precedence at run time).
      await ctx.db
        .insert(userOpenaiCredentials)
        .values({ userId: ctx.session.user.id, apiKey: input.apiKey })
        .onConflictDoUpdate({
          target: userOpenaiCredentials.userId,
          set: { apiKey: input.apiKey, updatedAt: new Date() },
        });

      return { valid: true as const };
    }),

  setCodexAuth: protectedProcedure
    .input(z.object({ authJson: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const validation = validateCodexAuthJson(input.authJson);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "auth.json is invalid.",
        });
      }

      await ctx.db
        .insert(userOpenaiCredentials)
        .values({
          userId: ctx.session.user.id,
          codexAuthJson: input.authJson,
        })
        .onConflictDoUpdate({
          target: userOpenaiCredentials.userId,
          set: { codexAuthJson: input.authJson, updatedAt: new Date() },
        });

      return { valid: true as const };
    }),

  deleteOpenai: protectedProcedure
    .input(
      z.object({ kind: z.enum(["api_key", "chatgpt"]).optional() }).optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      if (input?.kind) {
        const creds = await getUserOpenaiCredentials(ctx.db, userId);
        const otherRemains =
          input.kind === "api_key" ? !!creds.codexAuthJson : !!creds.apiKey;
        if (otherRemains) {
          await ctx.db
            .update(userOpenaiCredentials)
            .set(
              input.kind === "api_key"
                ? { apiKey: null, updatedAt: new Date() }
                : { codexAuthJson: null, updatedAt: new Date() },
            )
            .where(eq(userOpenaiCredentials.userId, userId));
          return { success: true };
        }
      }
      await ctx.db
        .delete(userOpenaiCredentials)
        .where(eq(userOpenaiCredentials.userId, userId));
      return { success: true };
    }),

  // ── Gemini project credentials ──────────────────────────────────────────────

  geminiStatus: protectedProcedure.query(async ({ ctx }) => {
    const creds = await getUserGeminiKey(ctx.db, ctx.session.user.id);
    if (!creds) return { configured: false as const };
    const { projectId, clientEmail } = summarizeGeminiCredentials(creds);
    return { configured: true as const, projectId, clientEmail };
  }),

  testGemini: protectedProcedure.mutation(async ({ ctx }) => {
    const creds = await getUserGeminiKey(ctx.db, ctx.session.user.id);
    if (!creds)
      return { valid: false as const, error: "No credentials configured." };
    return validateGeminiCredentials(creds);
  }),

  setGemini: protectedProcedure
    .input(z.object({ credentials: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const validation = await validateGeminiCredentials(input.credentials);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Gemini credentials are invalid.",
        });
      }

      await ctx.db
        .insert(userGeminiCredentials)
        .values({ userId: ctx.session.user.id, apiKey: input.credentials })
        .onConflictDoUpdate({
          target: userGeminiCredentials.userId,
          set: { apiKey: input.credentials, updatedAt: new Date() },
        });

      return { valid: true as const };
    }),

  deleteGemini: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .delete(userGeminiCredentials)
      .where(eq(userGeminiCredentials.userId, ctx.session.user.id));
    return { success: true };
  }),

  // ── Kubeconfig ────────────────────────────────────────────────────────────

  kubeconfigStatus: protectedProcedure
    // `repoFullName` lets the status account for a repo's own kubeconfig: a repo
    // may provide (and prefer) its own cluster even when the user hasn't set one,
    // in which case the "Configure kubeconfig" prompt shouldn't render.
    .input(z.object({ repoFullName: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      // When the selected repo prefers its own shared credentials and has a set
      // configured, cluster access is the repo admin's responsibility — the
      // user must never be prompted to configure their own kubeconfig.
      const repo = input?.repoFullName
        ? await getRepoCredentials(ctx.db, input.repoFullName)
        : null;
      const managedByRepo =
        !!repo?.preferRepoCredentials &&
        (!!repo.kubeconfig ||
          !!repo.anthropicApiKey ||
          !!repo.openaiApiKey ||
          !!repo.geminiApiKey ||
          !!repo.aws);
      if (managedByRepo) {
        return {
          managedByRepo: true as const,
          configured: true,
        };
      }

      const kc = await resolveKubeconfig(
        ctx.db,
        ctx.session.user.id,
        input?.repoFullName,
      );
      return {
        managedByRepo: false as const,
        configured: !!kc,
      };
    }),

  testKubeconfig: protectedProcedure.mutation(async ({ ctx }) => {
    const kc = await getUserKubeconfig(ctx.db, ctx.session.user.id);
    if (!kc)
      return { valid: false as const, error: "No kubeconfig configured." };
    return validateKubeconfig(kc);
  }),

  setKubeconfig: protectedProcedure
    .input(z.object({ kubeconfig: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const validation = await validateKubeconfig(input.kubeconfig);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Kubeconfig is invalid.",
        });
      }

      await ctx.db
        .insert(userKubeconfig)
        .values({ userId: ctx.session.user.id, kubeconfig: input.kubeconfig })
        .onConflictDoUpdate({
          target: userKubeconfig.userId,
          set: { kubeconfig: input.kubeconfig, updatedAt: new Date() },
        });

      return { valid: true as const, version: validation.version };
    }),

  deleteKubeconfig: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .delete(userKubeconfig)
      .where(eq(userKubeconfig.userId, ctx.session.user.id));
    return { success: true };
  }),

  // ── Compute (agent CPU / memory limits) ───────────────────────────────────

  // The user's stored default compute for their agents (null fields = the
  // built-in limit). Non-secret; rendered as-is in settings.
  computeStatus: protectedProcedure.query(async ({ ctx }) => {
    const compute = await getUserCompute(ctx.db, ctx.session.user.id);
    return { cpu: compute?.cpu ?? null, memory: compute?.memory ?? null };
  }),

  // Set the user's default compute. Blank fields clear their default (fall
  // back to a repo default, then the built-in limit); both blank removes the
  // row entirely. Quantities are validated so a typo fails here, not as an
  // unschedulable or instantly-OOM-killed pod later.
  setCompute: protectedProcedure
    .input(z.object({ cpu: z.string(), memory: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { cpu, memory } = parseComputeInput(input.cpu, input.memory);

      if (cpu === null && memory === null) {
        await ctx.db
          .delete(userCompute)
          .where(eq(userCompute.userId, ctx.session.user.id));
        return { success: true };
      }

      await ctx.db
        .insert(userCompute)
        .values({ userId: ctx.session.user.id, cpu, memory })
        .onConflictDoUpdate({
          target: userCompute.userId,
          set: { cpu, memory, updatedAt: new Date() },
        });
      return { success: true };
    }),

  deleteCompute: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .delete(userCompute)
      .where(eq(userCompute.userId, ctx.session.user.id));
    return { success: true };
  }),
});
