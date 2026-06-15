import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { listModelsForUser } from "~/server/agents/models";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const modelsRouter = createTRPCRouter({
  // Lists the models available from the configured provider's API. When a repo
  // is given, repo-scoped credentials are considered alongside the user's own
  // per the repo's prefer-credentials flag.
  list: protectedProcedure
    .input(z.object({ repoFullName: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      try {
        return await listModelsForUser(
          ctx.db,
          ctx.session.user.id,
          input?.repoFullName,
        );
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to list models",
          cause: err,
        });
      }
    }),
});
