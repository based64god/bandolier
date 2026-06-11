import { TRPCError } from "@trpc/server";

import { listModelsForUser } from "~/server/agents/models";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const modelsRouter = createTRPCRouter({
  // Lists the models available from the user's configured provider's API.
  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await listModelsForUser(ctx.db, ctx.session.user.id);
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Failed to list models",
        cause: err,
      });
    }
  }),
});
