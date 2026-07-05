import { ghFetch } from "~/server/agents/github-api";
import {
  hasModelCredentials,
  type ModelCredentials,
  resolveModelCredentials,
} from "~/server/agents/resolve-credentials";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import { type db } from "~/server/db";

/**
 * GitHub's collaborator permission levels, ordered least → most privileged.
 * The REST API reports a user's role on a repo as one of these strings (the
 * `permission` field of the "Get repository permissions for a user" endpoint,
 * and the `role_name` it also returns for finer-grained roles).
 */
export type RepoPermission =
  | "none"
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

const PERMISSION_RANK: Record<RepoPermission, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

/**
 * Whether `permission` is maintainer-or-higher — the bar a GitHub user must
 * clear to run an agent on a repo's *shared* credentials (a repo-level
 * kubeconfig or model API key). Write/triage/read collaborators do not qualify;
 * only `maintain` and `admin` do.
 */
export function isMaintainerOrHigher(permission: RepoPermission): boolean {
  return PERMISSION_RANK[permission] >= PERMISSION_RANK.maintain;
}

interface RawPermission {
  // Coarse permission bucket GitHub maps the user's role into.
  permission?: string;
  // Finer-grained role name (covers custom org roles and "maintain"/"triage",
  // which the coarse `permission` field collapses into write/read).
  role_name?: string;
}

/** Coerces an arbitrary GitHub permission/role string into a RepoPermission. */
function normalizePermission(value: string | undefined): RepoPermission {
  switch (value) {
    case "admin":
      return "admin";
    case "maintain":
      return "maintain";
    case "write":
      return "write";
    case "triage":
      return "triage";
    case "read":
      return "read";
    default:
      return "none";
  }
}

/**
 * Resolves a GitHub user's permission level on a repo, querying as the bot via
 * an installation token (or any token with repo access). Uses the "Get
 * repository permissions for a user" endpoint, which reports both a coarse
 * `permission` and a finer `role_name`; we take the higher of the two so a
 * "maintain" role isn't lost when GitHub collapses it to "write" in the coarse
 * field. Returns "none" on any API error so callers fail closed (deny).
 */
export async function getUserRepoPermission(
  token: string,
  repoFullName: string,
  username: string,
): Promise<RepoPermission> {
  try {
    const res = await ghFetch(
      `https://api.github.com/repos/${repoFullName}/collaborators/${username}/permission`,
      token,
    );
    const data = (await res.json()) as RawPermission;
    const coarse = normalizePermission(data.permission);
    const role = normalizePermission(data.role_name);
    // Take the more privileged of the two interpretations.
    return PERMISSION_RANK[role] > PERMISSION_RANK[coarse] ? role : coarse;
  } catch {
    return "none";
  }
}

/**
 * Whether a given agent run for a user would actually consume repo-level shared
 * credentials (a shared kubeconfig or shared model API key) rather than that
 * user's own. This is the trigger for the maintainer-or-higher gate: spending a
 * repo's pooled infrastructure/keys must be limited to people trusted to run
 * arbitrary code with them.
 *
 * It mirrors the resolution logic used at deploy time:
 *   - The model credentials chosen are repo-scoped when `resolveModelCredentials`
 *     reports a "repo" source (the repo prefers its own and has some).
 *   - The kubeconfig chosen is repo-scoped when the repo prefers its own and has
 *     one, OR the user has none of their own and the repo supplies one.
 *
 * `resolved` may be passed in to avoid re-resolving when the caller already has
 * it; otherwise it's resolved here.
 */
export async function runUsesRepoCredentials(
  database: typeof db,
  userId: string,
  repoFullName: string,
  resolved?: ModelCredentials,
): Promise<boolean> {
  const repo = await getRepoCredentials(database, repoFullName);
  if (!repo) return false;

  // Model credentials: repo-sourced when the resolver picked the repo set.
  const creds =
    resolved ?? (await resolveModelCredentials(database, userId, repoFullName));
  if (creds.source === "repo" && hasModelCredentials(creds)) return true;

  // Kubeconfig: repo-scoped when the repo prefers its own and has one, or the
  // user has no kubeconfig of their own and the repo provides one. We avoid a
  // second user-kubeconfig read by reusing resolveKubeconfig's precedence: the
  // repo's wins only under those two conditions, both of which require the repo
  // to actually have a kubeconfig.
  if (repo.kubeconfig) {
    const { getUserKubeconfig } = await import("~/server/agents/kubeconfig");
    const userKc = await getUserKubeconfig(database, userId);
    if (repo.preferRepoCredentials || !userKc) return true;
  }

  return false;
}
