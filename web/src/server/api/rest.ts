import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { totalTokens, type TokenUsage } from "~/lib/tokens";
import { resolveApiKey } from "~/server/agents/api-keys";
import { getRepoAccess } from "~/server/agents/github-api";
import { getUserGithubToken } from "~/server/agents/github-token";
import { repoToNamespace } from "~/server/agents/namespace";
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

  const access = await getRepoAccess(token, fullName);
  if (!access.accessible) return null;

  return {
    cloneUrl: access.cloneUrl!,
    defaultBranch: access.defaultBranch!,
  };
}

type RestContext = {
  userId: string;
  caller: NonNullable<Awaited<ReturnType<typeof callerForUser>>>;
  access: { cloneUrl: string; defaultBranch: string };
  fullName: string;
  namespace: string;
};

/**
 * Shared REST setup: authenticate, confirm repo access, and build a tRPC caller.
 * Returns `{ error }` (a ready-to-return response) when any step fails, or the
 * resolved context — including `access` (cloneUrl/defaultBranch) for deploys.
 */
export async function resolve(
  req: NextRequest,
  fullName: string,
): Promise<{ error: NextResponse } | RestContext> {
  const userId = await authenticate(req);
  if (!userId) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const access = await getAccessibleRepo(userId, fullName);
  if (!access) {
    return {
      error: NextResponse.json(
        { error: "Repository not found or not accessible" },
        { status: 403 },
      ),
    };
  }

  const caller = await callerForUser(userId);
  if (!caller) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return {
    userId,
    caller,
    access,
    fullName,
    namespace: repoToNamespace(fullName),
  };
}

/**
 * Wraps a route handler so any thrown error becomes the standard REST error
 * envelope (`{ error }` with a tRPC-derived status) instead of a raw 500.
 */
export function restHandler<T extends unknown[]>(
  fn: (...args: T) => Promise<NextResponse>,
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      return NextResponse.json(
        { error: errorMessage(err) },
        { status: statusForTrpcError(err) },
      );
    }
  };
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
  tokens?: TokenUsage | null;
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
    // The run's token usage: the per-category breakdown plus the grand total,
    // or null when the run hasn't reported any (or the provider doesn't).
    tokens: t.tokens
      ? { ...t.tokens, totalTokens: totalTokens(t.tokens) }
      : null,
  };
}
