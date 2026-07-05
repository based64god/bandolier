import crypto from "crypto";
import { eq } from "drizzle-orm";

import { ghHeaders, TtlMap } from "~/server/agents/github-api";
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
    { method: "POST", headers: ghHeaders(jwt) },
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

// Repo → installation id. The dashboard's list/overview polls resolve a bot
// token per pod every ~5s, and this lookup is the DB query behind each of
// those resolutions — cache it briefly so a poll costs one query per distinct
// repo per TTL instead of one per pod per poll. Nulls (App not installed) are
// cached too, since repos without the App are the common case on shared
// clusters. Webhook upserts/removes evict the entry, so installs and
// uninstalls take effect immediately; the TTL is only a backstop for a missed
// webhook.
const INSTALLATION_ID_TTL_MS = 60_000;
const INSTALLATION_ID_CACHE_MAX = 5_000;
const installationIdCache = new TtlMap<string, string | null>(
  INSTALLATION_ID_CACHE_MAX,
);

/**
 * Looks up the installation id recorded for a repo, or null when the App isn't
 * installed there (so callers can fall back gracefully).
 */
export async function getInstallationIdForRepo(
  database: typeof db,
  repoFullName: string,
): Promise<string | null> {
  const now = Date.now();
  const cached = installationIdCache.get(repoFullName, now);
  // A fresh entry is `string | null`; `undefined` means absent or expired.
  if (cached !== undefined) return cached;

  const [row] = await database
    .select({ installationId: githubInstallation.installationId })
    .from(githubInstallation)
    .where(eq(githubInstallation.repoFullName, repoFullName))
    .limit(1);
  const id = row?.installationId ?? null;
  installationIdCache.set(repoFullName, id, now, now + INSTALLATION_ID_TTL_MS);
  return id;
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
  installationIdCache.delete(repoFullName);
}

/** Removes the installation mapping for a repo (uninstall / repo removed). */
export async function removeInstallation(
  database: typeof db,
  repoFullName: string,
): Promise<void> {
  const removed = await database
    .delete(githubInstallation)
    .where(eq(githubInstallation.repoFullName, repoFullName))
    .returning({ installationId: githubInstallation.installationId });
  installationIdCache.delete(repoFullName);
  // Drop the cached token for the removed installation so an uninstall can't
  // be served a revoked (or soon-revoked) token from cache. An org-wide
  // installation shared with other repos just re-mints on its next use.
  for (const row of removed) tokenCache.delete(row.installationId);
}

/** Drops a single installation's cached token. Exposed for tests. */
export function clearTokenCache(installationId?: string): void {
  if (installationId) tokenCache.delete(installationId);
  else tokenCache.clear();
}

// ── Registry pull credentials (private custom agent images) ───────────────────

/** GitHub Container Registry. Private packages here are pulled with the
 * triggering user's GitHub OAuth token: GHCR does not accept GitHub App
 * installation tokens, so the bot identity can't pull a private image. */
export const GHCR_REGISTRY = "ghcr.io";

/**
 * The registry host of a container image reference, or null when the image uses
 * the implicit Docker Hub default (no host component). A leading path segment is
 * the registry only when it looks like a host — it contains a `.` or `:`, or is
 * exactly `localhost` — matching Docker's own reference grammar. Examples:
 *   ghcr.io/acme/img:tag        → "ghcr.io"
 *   registry.example.com:5000/x → "registry.example.com:5000"
 *   acme/bandolier-agent        → null  (Docker Hub)
 *   bandolier-agent             → null
 */
export function imageRegistryHost(image: string): string | null {
  const firstSlash = image.indexOf("/");
  if (firstSlash === -1) return null;
  const candidate = image.slice(0, firstSlash);
  if (
    candidate === "localhost" ||
    candidate.includes(".") ||
    candidate.includes(":")
  ) {
    return candidate;
  }
  return null;
}

/**
 * A Kubernetes `kubernetes.io/dockerconfigjson` payload authenticating to a
 * single registry with a username/password (here, the triggering user's GitHub
 * OAuth token). Returned as the JSON string Kubernetes expects under the
 * `.dockerconfigjson` key.
 */
export function buildDockerConfigJson(
  registry: string,
  username: string,
  password: string,
): string {
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  return JSON.stringify({
    auths: { [registry]: { username, password, auth } },
  });
}

/** Resolved pull credentials for a private agent image: the registry host and
 * the dockerconfigjson Kubernetes stores in an image-pull Secret. */
export interface RegistryPullSecret {
  registry: string;
  dockerConfigJson: string;
}

/**
 * Resolves image-pull credentials for a repo's custom agent image, or null when
 * none are needed or available. The built-in default harness image is public, so
 * only a per-repo `agentImage` override can require auth — and only when it lives
 * on `ghcr.io`. Authentication uses the triggering user's GitHub OAuth token
 * (with `read:packages`): GHCR rejects GitHub App installation tokens, so the
 * pull is attributed to the user who opened the issue / deployed the agent —
 * exactly like cloning and PR authorship. Any other registry (or a public
 * ghcr.io image) is left to the cluster's own node credentials.
 *
 * Best-effort and non-throwing: a non-GHCR image, or a user with no linked
 * GitHub token, returns null so the deploy proceeds — Kubernetes will still pull
 * a public image, and surface an ImagePullBackOff for a genuinely private one
 * (e.g. the user lacks `read:packages` or package access) rather than failing
 * the deploy outright.
 */
export function getRegistryPullSecret(
  image: string,
  githubToken: string | null | undefined,
): RegistryPullSecret | null {
  if (imageRegistryHost(image) !== GHCR_REGISTRY) return null;
  if (!githubToken) return null;

  // GHCR ignores the username for token auth, but it must be non-empty; the
  // conventional placeholder for "the password is a token" is x-access-token.
  return {
    registry: GHCR_REGISTRY,
    dockerConfigJson: buildDockerConfigJson(
      GHCR_REGISTRY,
      "x-access-token",
      githubToken,
    ),
  };
}
