import { and, eq } from "drizzle-orm";

import { type db } from "~/server/db";
import { account } from "~/server/db/schema";

/**
 * Returns the GitHub OAuth access token Better Auth stored for the given user
 * at sign-in, or null if they haven't linked a GitHub account.
 */
export async function getUserGithubToken(
  database: typeof db,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  return row?.accessToken ?? null;
}

/**
 * Resolves the Bandolier user linked to a GitHub account by the GitHub numeric
 * user id (the webhook payload's `sender.id`), returning their internal user id
 * and stored OAuth token. Used to attribute webhook-triggered agents to a real
 * user — there is no server identity to fall back on.
 */
export async function getGithubAccountByGithubId(
  database: typeof db,
  githubUserId: string,
): Promise<{ userId: string; accessToken: string | null } | null> {
  const [row] = await database
    .select({ userId: account.userId, accessToken: account.accessToken })
    .from(account)
    .where(
      and(
        eq(account.providerId, "github"),
        eq(account.accountId, githubUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}
