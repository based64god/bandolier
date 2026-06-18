import crypto from "crypto";
import { eq } from "drizzle-orm";

import { env } from "~/env";
import { type db } from "~/server/db";
import { githubInstallation } from "~/server/db/schema";

/**
 * Mints installation access tokens for the Bandolier GitHub App — the bot
 * identity used for actions that should NOT be attributed to a user (issue/PR
 * comments and other UX tie-ins). User-attribution-sensitive work (clone, push,
 * PR authorship) continues to use each user's own OAuth token; the App key never
 * touches it.
 *
 * Flow: sign a short-lived App JWT with the App private key → exchange it for an
 * installation access token scoped to a single installation. Installation tokens
 * live ~1h, so they're cached and only ever used for short bot calls — never
 * handed to a long-running agent job.
 */

// ── App JWT ─────────────────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The App private key as a usable PEM. GitHub hands out a multi-line PEM; stored
 * in env it's typically `\n`-escaped, so un-escape before signing.
 */
function privateKeyPem(): string {
  return env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");
}

/**
 * Builds a GitHub App JWT (RS256) valid for ~10 minutes — the credential used to
 * authenticate *as the App* when listing installations or minting installation
 * tokens. `iat` is backdated 60s to tolerate minor clock skew, as GitHub
 * recommends. `nowSeconds` is injected so callers (and tests) control the clock.
 */
export function buildAppJwt(nowSeconds: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    // Backdate to absorb clock drift between us and GitHub.
    iat: nowSeconds - 60,
    // GitHub rejects JWTs with an expiry more than 10 minutes out.
    exp: nowSeconds + 9 * 60,
    iss: env.GITHUB_APP_ID,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKeyPem());
  return `${signingInput}.${base64url(signature)}`;
}

/** Whether the App credentials needed to mint tokens are configured. */
export function isGithubAppConfigured(): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

// ── Installation token broker ─────────────────────────────────────────────────

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must not be reused. */
  expiresAt: number;
}

// Installation id → cached token. Process-local; a cold start just re-mints.
const tokenCache = new Map<string, CachedToken>();

// Installation tokens live 1h; refresh a little early so a token handed out
// here can't expire mid-call.
const TOKEN_TTL_MS = 60 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

interface RawInstallationToken {
  token: string;
  expires_at: string;
}

/**
 * Mints (or returns a cached) installation access token for a given installation
 * id. The token authenticates bot-voice GitHub API calls. Throws when the App
 * isn't configured or GitHub rejects the request.
 *
 * `nowMs` is injected for testability; production callers pass `Date.now()`.
 */
export async function getInstallationToken(
  installationId: string,
  nowMs: number,
): Promise<string> {
  if (!isGithubAppConfigured()) {
    throw new Error("GitHub App is not configured");
  }

  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > nowMs) {
    return cached.token;
  }

  const jwt = buildAppJwt(Math.floor(nowMs / 1000));
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub App token exchange failed: ${res.status} ${res.statusText}`,
    );
  }
  const data = (await res.json()) as RawInstallationToken;
  // Trust GitHub's expiry when present, else assume the documented 1h.
  const expiresAt = data.expires_at
    ? Date.parse(data.expires_at)
    : nowMs + TOKEN_TTL_MS;
  tokenCache.set(installationId, { token: data.token, expiresAt });
  return data.token;
}

/**
 * Looks up the installation id recorded for a repo, or null when the App isn't
 * installed there (so callers can fall back gracefully).
 */
export async function getInstallationIdForRepo(
  database: typeof db,
  repoFullName: string,
): Promise<string | null> {
  const [row] = await database
    .select({ installationId: githubInstallation.installationId })
    .from(githubInstallation)
    .where(eq(githubInstallation.repoFullName, repoFullName))
    .limit(1);
  return row?.installationId ?? null;
}

/**
 * Resolves a bot installation token for a repo: the one credential to use for
 * bot-voice actions (e.g. issue comments). Returns null — never throws — when
 * the App is unconfigured or not installed on the repo, so callers can fall back
 * to a legacy token or simply skip the bot action.
 */
export async function getRepoBotToken(
  database: typeof db,
  repoFullName: string,
  nowMs: number,
): Promise<string | null> {
  if (!isGithubAppConfigured()) return null;
  const installationId = await getInstallationIdForRepo(database, repoFullName);
  if (!installationId) return null;
  try {
    return await getInstallationToken(installationId, nowMs);
  } catch (err) {
    console.warn("[bandolier:github-app] failed to mint installation token", {
      repo: repoFullName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Installation tracking (webhook-maintained) ────────────────────────────────

/** Records (or refreshes) the installation mapping for a repo. */
export async function upsertInstallation(
  database: typeof db,
  repoFullName: string,
  installationId: string,
  accountLogin: string | null,
): Promise<void> {
  await database
    .insert(githubInstallation)
    .values({ repoFullName, installationId, accountLogin })
    .onConflictDoUpdate({
      target: githubInstallation.repoFullName,
      set: { installationId, accountLogin, updatedAt: new Date() },
    });
}

/** Removes the installation mapping for a repo (uninstall / repo removed). */
export async function removeInstallation(
  database: typeof db,
  repoFullName: string,
): Promise<void> {
  tokenCache.delete(repoFullName);
  await database
    .delete(githubInstallation)
    .where(eq(githubInstallation.repoFullName, repoFullName));
}

/** Drops a single installation's cached token. Exposed for tests. */
export function clearTokenCache(installationId?: string): void {
  if (installationId) tokenCache.delete(installationId);
  else tokenCache.clear();
}
