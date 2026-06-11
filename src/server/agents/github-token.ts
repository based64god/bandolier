import { and, eq } from "drizzle-orm";

import { type db } from "~/server/db";
import { account } from "~/server/db/schema";

/** A git author identity (commit `user.name` / `user.email`). */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Builds a git identity whose email is the user's GitHub no-reply address
 * (`<id>+<login>@users.noreply.github.com`). Committing with this email
 * guarantees GitHub attributes the commit to that account — it survives username
 * changes and doesn't depend on the user exposing a verified public email.
 */
export function githubGitIdentity(
  githubUserId: string | number,
  login: string,
): GitIdentity {
  return {
    name: login,
    email: `${githubUserId}+${login}@users.noreply.github.com`,
  };
}

/**
 * Fetches the authenticated GitHub user's numeric id and login from their OAuth
 * token. Used to build a no-reply commit identity when only the token is on hand
 * (the dashboard deploy path); the webhook path already has both from the event.
 */
export async function getGithubIdentity(
  accessToken: string,
): Promise<{ id: number; login: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as { id: number; login: string };
  return { id: data.id, login: data.login };
}

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
