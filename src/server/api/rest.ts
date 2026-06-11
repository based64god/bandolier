import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { resolveApiKey } from "~/server/agents/api-keys";
import { getUserGithubToken } from "~/server/agents/github-token";
import { auth } from "~/server/better-auth";
import { db } from "~/server/db";
import { user } from "~/server/db/schema";
import { createCaller } from "~/server/api/root";

/**
 * Resolves the acting user for a REST request. An API key (Authorization:
 * Bearer <key>, or x-api-key) takes precedence; otherwise the session cookie is
 * used. Either way the request acts as a real user with that user's permissions.
 */
export async function authenticate(req: Request): Promise<string | null> {
  const bearer = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const token = bearer ?? req.headers.get("x-api-key")?.trim();

  if (token) {
    const resolved = await resolveApiKey(db, token);
    return resolved?.userId ?? null;
  }

  const session = await auth.api.getSession({ headers: req.headers });
  return session?.user.id ?? null;
}

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** Minimal session standing in for the API-key/session user inside tRPC. */
function syntheticSession(u: {
  id: string;
  name: string;
  email: string;
  image: string | null;
}): AuthSession {
  const now = new Date();
  return {
    session: {
      id: `rest:${u.id}`,
      token: "",
      userId: u.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      emailVerified: true,
      image: u.image,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Builds a tRPC caller that runs as the given user, so REST endpoints reuse the
 * exact same procedures (and permission checks) as the dashboard.
 */
export async function callerForUser(userId: string) {
  const [u] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!u) return null;

  return createCaller({
    db,
    session: syntheticSession(u),
    headers: new Headers(),
  });
}

/**
 * Confirms the user can reach the repo via their own GitHub token and returns
 * the details a deploy needs. Null = no token, no access, or repo not found —
 * the caller should treat all of these as "forbidden" so task existence isn't
 * leaked.
 */
export async function getAccessibleRepo(
  userId: string,
  fullName: string,
): Promise<{ cloneUrl: string; defaultBranch: string } | null> {
  const token = await getUserGithubToken(db, userId);
  if (!token) return null;

  const res = await fetch(`https://api.github.com/repos/${fullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    clone_url: string;
    default_branch: string;
  };
  return { cloneUrl: data.clone_url, defaultBranch: data.default_branch };
}

/** Maps a tRPC error to an HTTP status for the REST surface. */
export function statusForTrpcError(err: unknown): number {
  if (err instanceof TRPCError) {
    switch (err.code) {
      case "NOT_FOUND":
        return 404;
      case "BAD_REQUEST":
        return 400;
      case "UNAUTHORIZED":
        return 401;
      case "FORBIDDEN":
        return 403;
      default:
        return 500;
    }
  }
  return 500;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Internal error";
}

/** Reshapes an internal task object into the public REST representation. */
export function toTaskResource(t: {
  name: string;
  jobName: string;
  repoFullName: string | null;
  displayName: string;
  prompt: string | null;
  source: string;
  issueNumber: string | null;
  issueUrl: string | null;
  createdBy: string | null;
  status: string;
  currently: string | null;
  expiresAt: string | null;
  pullRequestUrl: string | null;
}) {
  return {
    id: t.jobName,
    podName: t.name,
    repo: t.repoFullName,
    displayName: t.displayName,
    prompt: t.prompt,
    source: t.source,
    issueNumber: t.issueNumber,
    issueUrl: t.issueUrl,
    createdBy: t.createdBy,
    status: t.status,
    currently: t.currently,
    pullRequestUrl: t.pullRequestUrl,
    expiresAt: t.expiresAt,
  };
}
