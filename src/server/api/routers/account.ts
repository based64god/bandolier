import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  getUserAnthropicKey,
  validateAnthropicKey,
} from "~/server/agents/anthropic";
import { cleanSessionToken, validateAwsCredentials } from "~/server/agents/aws";
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
import { getUserOpenaiKey, validateOpenaiKey } from "~/server/agents/openai";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import {
  userAnthropicCredentials,
  userAwsCredentials,
  userGeminiCredentials,
  userKubeconfig,
  userOpenaiCredentials,
} from "~/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
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

  // ── Anthropic API key ─────────────────────────────────────────────────────

  anthropicStatus: protectedProcedure.query(async ({ ctx }) => {
    const key = await getUserAnthropicKey(ctx.db, ctx.session.user.id);
    if (!key) return { configured: false as const };
    return { configured: true as const, apiKeyMasked: maskKey(key) };
  }),

  testAnthropic: protectedProcedure.mutation(async ({ ctx }) => {
    const key = await getUserAnthropicKey(ctx.db, ctx.session.user.id);
    if (!key) return { valid: false as const, error: "No API key configured." };
    return validateAnthropicKey(key);
  }),

  setAnthropic: protectedProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const validation = await validateAnthropicKey(input.apiKey);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error ?? "Anthropic API key is invalid.",
        });
      }

      await ctx.db
        .insert(userAnthropicCredentials)
        .values({ userId: ctx.session.user.id, apiKey: input.apiKey })
        .onConflictDoUpdate({
          target: userAnthropicCredentials.userId,
          set: { apiKey: input.apiKey, updatedAt: new Date() },
        });

      return { valid: true as const };
    }),

  deleteAnthropic: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .delete(userAnthropicCredentials)
      .where(eq(userAnthropicCredentials.userId, ctx.session.user.id));
    return { success: true };
  }),

  // ── OpenAI API key ────────────────────────────────────────────────────────

  openaiStatus: protectedProcedure.query(async ({ ctx }) => {
    const key = await getUserOpenaiKey(ctx.db, ctx.session.user.id);
    if (!key) return { configured: false as const };
    return { configured: true as const, apiKeyMasked: maskKey(key) };
  }),

  testOpenai: protectedProcedure.mutation(async ({ ctx }) => {
    const key = await getUserOpenaiKey(ctx.db, ctx.session.user.id);
    if (!key) return { valid: false as const, error: "No API key configured." };
    return validateOpenaiKey(key);
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

      await ctx.db
        .insert(userOpenaiCredentials)
        .values({ userId: ctx.session.user.id, apiKey: input.apiKey })
        .onConflictDoUpdate({
          target: userOpenaiCredentials.userId,
          set: { apiKey: input.apiKey, updatedAt: new Date() },
        });

      return { valid: true as const };
    }),

  deleteOpenai: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .delete(userOpenaiCredentials)
      .where(eq(userOpenaiCredentials.userId, ctx.session.user.id));
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
});
