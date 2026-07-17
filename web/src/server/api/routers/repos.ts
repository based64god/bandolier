import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { fetchAccessibleRepos } from "~/server/agents/github-repos";
import { listOpenIssues, listOpenPulls } from "~/server/agents/github-issues";
import { getUserGithubToken } from "~/server/agents/github-token";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const reposRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    // Retrieve the GitHub OAuth access token stored by Better Auth at sign-in.
    const accessToken = await getUserGithubToken(ctx.db, ctx.session.user.id);
    if (!accessToken) {
      // User is logged in but hasn't linked a GitHub account.
      return [];
    }

    try {
      return await fetchAccessibleRepos(accessToken);
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to list repositories",
        cause: err,
      });
    }
  }),

  // Lists open issues for a repo, for the deploy modal's issue picker.
  issues: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const accessToken = await getUserGithubToken(ctx.db, ctx.session.user.id);
      if (!accessToken) return [];
      try {
        return await listOpenIssues(accessToken, input.repoFullName);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to list issues",
          cause: err,
        });
      }
    }),

  // Lists open pull requests for a repo, for the deploy modal's review picker.
  pulls: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const accessToken = await getUserGithubToken(ctx.db, ctx.session.user.id);
      if (!accessToken) return [];
      try {
        return await listOpenPulls(accessToken, input.repoFullName);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            err instanceof Error ? err.message : "Failed to list pull requests",
          cause: err,
        });
      }
    })
});
