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
import { type Validation } from "~/server/agents/validation";
import { type db } from "~/server/db";
import {
  userAnthropicCredentials,
  userAwsCredentials,
  userCompute,
  userGeminiCredentials,
  userKubeconfig,
  userOpenaiCredentials,
} from "~/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Builds a user-scoped credential `set` mutation. Every setter is the same
 * shape — validate the input, reject with the validation error, then upsert —
 * so they differ only in schema, validator, and how the validated input maps
 * onto a row (`store`). `toResult` surfaces any success detail the UI shows (a
 * cluster version) alongside `{ valid: true }`.
 */
function userCredentialSetter<
  TSchema extends z.ZodTypeAny,
  TValidation extends Validation,
  TResult extends Record<string, unknown> = Record<string, never>,
>(config: {
  inputSchema: TSchema;
  validate: (input: z.infer<TSchema>) => Promise<TValidation> | TValidation;
  store: (
    database: typeof db,
    userId: string,
    input: z.infer<TSchema>,
  ) => Promise<void>;
  invalidMessage: string;
  toResult?: (validation: Extract<TValidation, { valid: true }>) => TResult;
}) {
  return protectedProcedure
    .input(config.inputSchema)
    .mutation(async ({ ctx, input }) => {
      const parsed = input as z.infer<TSchema>;
      const validation = await config.validate(parsed);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error || config.invalidMessage,
        });
      }
      await config.store(ctx.db, ctx.session.user.id, parsed);
      const extra = config.toResult?.(
        validation as Extract<TValidation, { valid: true }>,
      );
      return { valid: true as const, ...(extra ?? ({} as Partial<TResult>)) };
    });
}

/**
 * Builds a user-scoped credential `delete` mutation that removes the whole row
 * for the current user. `remove` is a closure so each provider keeps its own
 * (fully typed) table reference.
 */
function userCredentialDelete(
  remove: (database: typeof db, userId: string) => Promise<void>,
) {
  return protectedProcedure.mutation(async ({ ctx }) => {
    await remove(ctx.db, ctx.session.user.id);
    return { success: true };
  });
}

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
  setAws: userCredentialSetter({
    inputSchema: z.object({
      // Trim to avoid whitespace from pasted blocks corrupting the signature
      // (AWS reports that as a generic "security token invalid" error).
      accessKeyId: z.string().trim().min(16),
      secretAccessKey: z.string().trim().min(1),
      // Optional: blank / whitespace-only normalizes to undefined so a
      // permanent-credential user is never treated as needing a session token.
      sessionToken: z.string().optional().transform(cleanSessionToken),
      region: z.string().trim().min(1).default("us-east-1"),
    }),
    validate: (input) =>
      validateAwsCredentials({
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        sessionToken: input.sessionToken,
        region: input.region,
      }),
    store: (database, userId, input) =>
      database
        .insert(userAwsCredentials)
        .values({
          userId,
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
        })
        .then(() => undefined),
    invalidMessage: "AWS credentials are invalid.",
    toResult: (validation) => ({ arn: validation.arn }),
  }),

  deleteAws: userCredentialDelete((database, userId) =>
    database
      .delete(userAwsCredentials)
      .where(eq(userAwsCredentials.userId, userId))
      .then(() => undefined),
  ),

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

  setAnthropic: userCredentialSetter({
    // Strip ALL whitespace, not just the ends: a key copied from a wrapped
    // terminal line arrives with interior spaces/newlines that survive trim().
    inputSchema: z.object({ apiKey: stripWhitespace.pipe(z.string().min(1)) }),
    validate: (input) => validateAnthropicKey(input.apiKey),
    // Both kinds can coexist — setting the key leaves any OAuth token alone
    // (the key takes precedence at run time).
    store: (database, userId, input) =>
      database
        .insert(userAnthropicCredentials)
        .values({ userId, apiKey: input.apiKey })
        .onConflictDoUpdate({
          target: userAnthropicCredentials.userId,
          set: { apiKey: input.apiKey, updatedAt: new Date() },
        })
        .then(() => undefined),
    invalidMessage: "Anthropic API key is invalid.",
  }),

  setAnthropicOauth: userCredentialSetter({
    // Strip ALL whitespace, not just the ends: a setup-token copied from a
    // wrapped terminal line arrives with interior spaces that survive trim(),
    // pass the format check, and only fail at run time as the claude CLI's
    // "401 Invalid bearer token" (OAuth tokens can't be probed at save time).
    inputSchema: z.object({
      oauthToken: stripWhitespace.pipe(z.string().min(1)),
    }),
    validate: (input) => validateAnthropicOauthToken(input.oauthToken),
    store: (database, userId, input) =>
      database
        .insert(userAnthropicCredentials)
        .values({ userId, oauthToken: input.oauthToken })
        .onConflictDoUpdate({
          target: userAnthropicCredentials.userId,
          set: { oauthToken: input.oauthToken, updatedAt: new Date() },
        })
        .then(() => undefined),
    invalidMessage: "OAuth token is invalid.",
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

  setOpenai: userCredentialSetter({
    inputSchema: z.object({ apiKey: z.string().min(1) }),
    validate: (input) => validateOpenaiKey(input.apiKey),
    // Both kinds can coexist — setting the key leaves any ChatGPT auth alone
    // (the key takes precedence at run time).
    store: (database, userId, input) =>
      database
        .insert(userOpenaiCredentials)
        .values({ userId, apiKey: input.apiKey })
        .onConflictDoUpdate({
          target: userOpenaiCredentials.userId,
          set: { apiKey: input.apiKey, updatedAt: new Date() },
        })
        .then(() => undefined),
    invalidMessage: "OpenAI API key is invalid.",
  }),

  setCodexAuth: userCredentialSetter({
    inputSchema: z.object({ authJson: z.string().trim().min(1) }),
    validate: (input) => validateCodexAuthJson(input.authJson),
    store: (database, userId, input) =>
      database
        .insert(userOpenaiCredentials)
        .values({ userId, codexAuthJson: input.authJson })
        .onConflictDoUpdate({
          target: userOpenaiCredentials.userId,
          set: { codexAuthJson: input.authJson, updatedAt: new Date() },
        })
        .then(() => undefined),
    invalidMessage: "auth.json is invalid.",
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

  setGemini: userCredentialSetter({
    inputSchema: z.object({ credentials: z.string().min(1) }),
    validate: (input) => validateGeminiCredentials(input.credentials),
    store: (database, userId, input) =>
      database
        .insert(userGeminiCredentials)
        .values({ userId, apiKey: input.credentials })
        .onConflictDoUpdate({
          target: userGeminiCredentials.userId,
          set: { apiKey: input.credentials, updatedAt: new Date() },
        })
        .then(() => undefined),
    invalidMessage: "Gemini credentials are invalid.",
  }),

  deleteGemini: userCredentialDelete((database, userId) =>
    database
      .delete(userGeminiCredentials)
      .where(eq(userGeminiCredentials.userId, userId))
      .then(() => undefined),
  ),

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

  setKubeconfig: userCredentialSetter({
    inputSchema: z.object({ kubeconfig: z.string().min(1) }),
    validate: (input) => validateKubeconfig(input.kubeconfig),
    store: (database, userId, input) =>
      database
        .insert(userKubeconfig)
        .values({ userId, kubeconfig: input.kubeconfig })
        .onConflictDoUpdate({
          target: userKubeconfig.userId,
          set: { kubeconfig: input.kubeconfig, updatedAt: new Date() },
        })
        .then(() => undefined),
    invalidMessage: "Kubeconfig is invalid.",
    toResult: (validation) => ({ version: validation.version }),
  }),

  deleteKubeconfig: userCredentialDelete((database, userId) =>
    database
      .delete(userKubeconfig)
      .where(eq(userKubeconfig.userId, userId))
      .then(() => undefined),
  ),

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

  deleteCompute: userCredentialDelete((database, userId) =>
    database
      .delete(userCompute)
      .where(eq(userCompute.userId, userId))
      .then(() => undefined),
  ),
});
