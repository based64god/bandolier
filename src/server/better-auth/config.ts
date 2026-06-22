import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { env } from "~/env";
import { db } from "~/server/db";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: env.BETTER_AUTH_GITHUB_CLIENT_ID,
      clientSecret: env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
      // repo:          list repositories + clone/push (incl. private).
      // workflow:      required to push changes that touch .github/workflows/*,
      //                otherwise GitHub rejects the push and PR creation fails.
      // read:packages: pull private custom harness images from GHCR. GHCR
      //                rejects GitHub App installation tokens, so the pull is
      //                done with the triggering user's OAuth token instead.
      scope: ["repo", "workflow", "read:packages"],
    },
  },
});

export type Session = typeof auth.$Infer.Session;
