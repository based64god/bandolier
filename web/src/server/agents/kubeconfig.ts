import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { eq } from "drizzle-orm";

import { env } from "~/env";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import { type db } from "~/server/db";
import { userKubeconfig } from "~/server/db/schema";
import type { Validation } from "~/server/agents/validation";
import {
  getKubeconfigServer,
  getVersionApi,
  unsupportedKubeconfigAuth,
} from "~/server/k8s/client";

/**
 * The result of validating a kubeconfig: on success the reachable cluster's
 * Kubernetes server version, on failure a human-readable reason.
 */
export type KubeconfigValidation = Validation<{
  /** The Kubernetes server version when reachable (e.g. "v1.31.0"). */
  version?: string;
}>;

/**
 * Whether an IP is in the link-local range (IPv4 169.254.0.0/16, IPv6 fe80::/10),
 * which is where cloud instance-metadata services live (e.g. 169.254.169.254).
 * Such addresses are never a legitimate Kubernetes API server, so we block the
 * validation probe from reaching them — that's the credential-theft SSRF target.
 * Note we deliberately do NOT block other private ranges (10/8, 192.168/16,
 * 127/8, …): those are legitimate on-prem / local (kind, minikube) clusters.
 */
function isMetadataAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped?.[1] ?? ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 169 && b === 254;
  }
  return ip.toLowerCase().startsWith("fe80");
}

/**
 * Guards the server-side validation probe against SSRF to a cloud metadata
 * endpoint: rejects when the cluster server is (or resolves to) a link-local
 * address. Throws with a clear message; a DNS-resolution failure is left for the
 * probe itself to report as "unreachable".
 */
async function assertNotMetadataHost(serverUrl: string): Promise<void> {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return; // malformed URL — the probe will surface a clear error
  }

  if (isIP(host)) {
    if (isMetadataAddress(host)) {
      throw new Error("cluster server points at a link-local/metadata address");
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return; // unresolvable — leave it to the probe
  }
  if (addresses.some((a) => isMetadataAddress(a.address))) {
    throw new Error("cluster server resolves to a link-local/metadata address");
  }
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

  // SSRF guard: this probe runs from the web server (not the sandboxed pod), so
  // block it from hitting a cloud metadata endpoint via a crafted server URL.
  const server = getKubeconfigServer(kubeconfig);
  if (server) {
    try {
      await assertNotMetadataHost(server);
    } catch (err) {
      return {
        valid: false,
        error:
          err instanceof Error
            ? `Invalid kubeconfig: ${err.message}`
            : "Cluster server address is not allowed.",
      };
    }
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

/**
 * Resolves the kubeconfig to use. The repo-scoped one and the user's own are
 * ordered by the repo's `preferRepoCredentials` flag (repo first when set, user
 * first otherwise), falling back to whichever is present; null when neither is.
 * `repoFullName` is optional — omit it for contexts with no repo (e.g. the
 * cross-repo overview), which then only considers the user's config.
 */
export async function resolveKubeconfig(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<string | null> {
  const userKc = await getUserKubeconfig(database, userId);
  const repo = repoFullName
    ? await getRepoCredentials(database, repoFullName)
    : null;
  const repoKc = repo?.kubeconfig ?? null;

  if (repo?.preferRepoCredentials) return repoKc ?? userKc;
  return userKc ?? repoKc;
}
