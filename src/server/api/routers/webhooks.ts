import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getUserGithubToken } from "~/server/agents/github-token";
import { canManageWebhooks } from "~/server/agents/webhook-config";
import { repoWebhookConfig } from "~/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

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
        })
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
        .limit(1);
      return {
        configured: !!row,
        updatedAt: row?.updatedAt ?? null,
        prefix: row?.prefix ?? "",
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
      if (!existing && !secret) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A webhook secret is required.",
        });
      }

      const prefix = input.prefix?.trim() ? input.prefix.trim() : null;

      if (existing) {
        await ctx.db
          .update(repoWebhookConfig)
          .set({
            prefix,
            configuredBy: ctx.session.user.id,
            updatedAt: new Date(),
            ...(secret ? { secret } : {}),
          })
          .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      } else {
        await ctx.db.insert(repoWebhookConfig).values({
          repoFullName: input.repoFullName,
          secret: secret!,
          prefix,
          configuredBy: ctx.session.user.id,
        });
      }
      return { success: true };
    }),

  deleteConfig: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .delete(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName));
      return { success: true };
    }),
});
