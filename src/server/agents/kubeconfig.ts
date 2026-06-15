import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { env } from "~/env";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import { type db } from "~/server/db";
import { userKubeconfig } from "~/server/db/schema";
import { getVersionApi, unsupportedKubeconfigAuth } from "~/server/k8s/client";

export interface KubeconfigValidation {
  valid: boolean;
  /** The Kubernetes server version when reachable (e.g. "v1.31.0"). */
  version?: string;
  error?: string;
}

/**
 * Validates a kubeconfig by parsing it and hitting the cluster's /version
 * endpoint — a cheap, unauthenticated-friendly call that confirms the config is
 * well-formed and the cluster is reachable with the embedded credentials.
 */
export async function validateKubeconfig(
  kubeconfig: string,
): Promise<KubeconfigValidation> {
  let api;
  try {
    api = getVersionApi(kubeconfig);
  } catch (err) {
    return {
      valid: false,
      error:
        err instanceof Error
          ? `Invalid kubeconfig: ${err.message}`
          : "Invalid kubeconfig.",
    };
  }

  // Reject auth methods the server can't satisfy (exec plugins, auth providers,
  // on-disk cert/key files) with a clear message instead of a cryptic runtime
  // failure like `spawn aws ENOENT` when the request is actually made.
  const unsupported = unsupportedKubeconfigAuth(kubeconfig);
  if (unsupported) {
    return {
      valid: false,
      error: `Unsupported kubeconfig: ${unsupported}. Generate a token-based one by running \`curl -fsSL ${env.BETTER_AUTH_URL}/setup.sh | bash\` against your cluster.`,
    };
  }

  try {
    const info = await api.getCode();
    return { valid: true, version: info.gitVersion };
  } catch (err) {
    return {
      valid: false,
      error:
        err instanceof Error ? err.message : "Could not reach the cluster.",
    };
  }
}

/** Loads a user's stored kubeconfig, or null if none is configured. */
export async function getUserKubeconfig(
  database: typeof db,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ kubeconfig: userKubeconfig.kubeconfig })
    .from(userKubeconfig)
    .where(eq(userKubeconfig.userId, userId))
    .limit(1);
  return row?.kubeconfig ?? null;
}

/** Whether a server-wide kubeconfig is configured (disables per-user config). */
export function isServerKubeconfigSet(): boolean {
  return !!env.SERVER_KUBECONFIG;
}

/**
 * The server-wide kubeconfig content, or null if not configured. SERVER_KUBECONFIG
 * may be inline YAML or a path to a kubeconfig file.
 */
export function getServerKubeconfig(): string | null {
  const value = env.SERVER_KUBECONFIG;
  if (!value) return null;
  // Inline YAML starts with apiVersion; otherwise treat it as a file path.
  return value.trimStart().startsWith("apiVersion")
    ? value
    : readFileSync(value, "utf8");
}

/**
 * Resolves the kubeconfig to use. Precedence:
 *  1. the server-wide kubeconfig, when configured (always overrides);
 *  2. otherwise the repo-scoped one vs. the user's own, ordered by the repo's
 *     `preferRepoCredentials` flag (repo first when set, user first otherwise),
 *     falling back to whichever is present;
 *  3. null when none is set.
 * `repoFullName` is optional — omit it for contexts with no repo (e.g. the
 * cross-repo overview), which then only considers the server/user configs.
 */
export async function resolveKubeconfig(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<string | null> {
  const server = getServerKubeconfig();
  if (server) return server;

  const userKc = await getUserKubeconfig(database, userId);
  const repo = repoFullName
    ? await getRepoCredentials(database, repoFullName)
    : null;
  const repoKc = repo?.kubeconfig ?? null;

  if (repo?.preferRepoCredentials) return repoKc ?? userKc;
  return userKc ?? repoKc;
}
