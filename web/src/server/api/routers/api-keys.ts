import { z } from "zod";

import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "~/server/agents/api-keys";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const apiKeysRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    return listApiKeys(ctx.db, ctx.session.user.id);
  }),

  // Returns the plaintext token exactly once — the caller must surface it
  // immediately, as it can never be retrieved again.
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null;
      return createApiKey(ctx.db, ctx.session.user.id, input.name, expiresAt);
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await revokeApiKey(ctx.db, ctx.session.user.id, input.id);
      return { success: true };
    }),
});
