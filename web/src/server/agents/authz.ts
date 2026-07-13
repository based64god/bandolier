import { TRPCError } from "@trpc/server";

import { env } from "~/env";
import { getUserGithubToken } from "~/server/agents/github-token";
import { userHasRepoAccess } from "~/server/agents/github-repos";
import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
import { repoToNamespace } from "~/server/agents/namespace";
import { getCoreV1Api } from "~/server/k8s/client";

const LABEL_SELECTOR = env.K8S_LABEL_SELECTOR;

/**
 * Resolves the kubeconfig to use (repo-scoped or the user's own — see
 * resolveKubeconfig), throwing if none is set. Pass `repoFullName` so a
 * repo's shared cluster is considered for repo-scoped views.
 */
export async function requireKubeconfig(
  db: Parameters<typeof resolveKubeconfig>[0],
  userId: string,
  repoFullName?: string,
): Promise<string> {
  const kubeconfig = await resolveKubeconfig(db, userId, repoFullName);
  if (!kubeconfig) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No kubeconfig configured. Add one in settings to manage agents.",
    });
  }
  return kubeconfig;
}

/**
 * Throws unless the acting user owns an agent with the given job name (matched by
 * the spawned-by label, so users can only send input to their own agents). The
 * pod must still exist, which it does for a live interactive session.
 */
export async function assertOwnsInteractiveJob(
  db: Parameters<typeof resolveKubeconfig>[0],
  userId: string,
  namespace: string,
  jobName: string,
  repoFullName?: string,
): Promise<void> {
  const kubeconfig = await requireKubeconfig(db, userId, repoFullName);
  const res = await getCoreV1Api(kubeconfig).listNamespacedPod({
    namespace,
    labelSelector: `${LABEL_SELECTOR},${SPAWNED_BY_LABEL}=${spawnedByLabelValue(userId)},bandolier.io/job=${jobName}`,
  });
  if (res.items.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Interactive agent ${jobName} not found.`,
    });
  }
}

/**
 * Label selector that restricts a pod query to the agents the given user spawned.
 * Pods carry SPAWNED_BY_LABEL, so this enforces per-user ownership on a shared
 * cluster/namespace (the same control overview and assertOwnsInteractiveJob use).
 * Pass `extra` to AND in a further selector (e.g. a specific job).
 */
export function ownedSelector(userId: string, extra?: string): string {
  const base = `${LABEL_SELECTOR},${SPAWNED_BY_LABEL}=${spawnedByLabelValue(userId)}`;
  return extra ? `${base},${extra}` : base;
}

/**
 * Label selector for a repo-scoped, read-only view. Tasks in a repo are visible
 * to every GitHub collaborator on that repo (the caller must already have
 * passed assertRepoAccess), not just their spawner — so when the query targets
 * the repo's own namespace, the spawned-by scoping is dropped. Any other
 * namespace/repo combination falls back to owner-scoping: the repo-access check
 * authorizes exactly one namespace (the repo's), and nothing else. Mutations
 * (terminate, rename, interactive input) never use this — they stay owner-only.
 */
export function repoViewSelector(
  userId: string,
  namespace: string,
  repoFullName?: string,
  extra?: string,
): string {
  if (repoFullName && namespace === repoToNamespace(repoFullName)) {
    return extra ? `${LABEL_SELECTOR},${extra}` : LABEL_SELECTOR;
  }
  return ownedSelector(userId, extra);
}

// Short-TTL cache of confirmed (user → repo) access, so polled procedures (list,
// getLogs run every ~5s) don't hit the GitHub API on every call. Only positive
// results are cached: a member's checks are served from memory, while a
// non-member's repeated probes are never cached, so the map can't be grown by
// guessing repo names and revoked access is re-verified within the TTL.
const repoAccessCache = new Map<string, number>();
const REPO_ACCESS_TTL_MS = 60_000;

/**
 * Gates access to repo-scoped resources (a repo's shared kubeconfig/credentials
 * and its namespace). When a repoFullName is supplied, the caller must be able to
 * reach that repo through their own GitHub token — otherwise we refuse rather
 * than resolve another team's shared cluster/credentials for them. A no-op for
 * repo-less (personal) operations, which only ever use the caller's own creds.
 */
export async function assertRepoAccess(
  db: Parameters<typeof resolveKubeconfig>[0],
  userId: string,
  repoFullName?: string,
): Promise<void> {
  if (!repoFullName) return;
  const key = `${userId} ${repoFullName}`;
  const cachedUntil = repoAccessCache.get(key);
  if (cachedUntil !== undefined && cachedUntil > Date.now()) return;

  const token = await getUserGithubToken(db, userId);
  if (!token || !(await userHasRepoAccess(token, repoFullName))) {
    repoAccessCache.delete(key);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You do not have access to ${repoFullName}.`,
    });
  }
  repoAccessCache.set(key, Date.now() + REPO_ACCESS_TTL_MS);
}
