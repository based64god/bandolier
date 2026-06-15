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
  isServerKubeconfigSet,
  resolveKubeconfig,
  validateKubeconfig,
} from "~/server/agents/kubeconfig";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
import {
  userAnthropicCredentials,
  userAwsCredentials,
  userKubeconfig,
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

  // ── Kubeconfig ────────────────────────────────────────────────────────────

  kubeconfigStatus: protectedProcedure
    // `repoFullName` lets the status account for a repo's own kubeconfig: a repo
    // may provide (and prefer) its own cluster even when the user hasn't set one,
    // in which case the "Configure kubeconfig" prompt shouldn't render.
    .input(
      z.object({ repoFullName: z.string().optional() }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const managedByServer = isServerKubeconfigSet();
      if (managedByServer) {
        return { managedByServer: true as const, configured: true };
      }
      const kc = await resolveKubeconfig(
        ctx.db,
        ctx.session.user.id,
        input?.repoFullName,
      );
      return { managedByServer: false as const, configured: !!kc };
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
      if (isServerKubeconfigSet()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "A server-wide kubeconfig is configured; it can't be overridden.",
        });
      }

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
