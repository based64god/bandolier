/**
 * GitHub repository-permission helpers used to gate runs that draw on
 * repo-level shared credentials (a repo kubeconfig or AI API keys). Such runs
 * execute with infrastructure trusted to the whole repo, so only collaborators
 * with at least the *maintain* role (maintain or admin) may dispatch them.
 *
 * Everything here fails closed: any API error, missing token, or unrecognized
 * response resolves to the least-privileged answer (role "none" / no access),
 * so a transient failure can never accidentally grant execution.
 */

/** GitHub's collaborator role ladder, least to most privileged. */
export type RepoRole =
  | "none"
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

// "Maintainer privileges or higher" — the bar for running with repo creds.
const MAINTAINER_ROLES: ReadonlySet<RepoRole> = new Set<RepoRole>([
  "maintain",
  "admin",
]);

/** Whether a role clears the maintainer bar (maintain or admin). */
export function isMaintainerRole(role: RepoRole): boolean {
  return MAINTAINER_ROLES.has(role);
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Normalizes GitHub's `role_name` / `permission` strings into a RepoRole. */
function toRepoRole(raw: string | null | undefined): RepoRole {
  switch (raw) {
    case "admin":
      return "admin";
    case "maintain":
      return "maintain";
    case "write":
    case "push":
      return "write";
    case "triage":
      return "triage";
    case "read":
    case "pull":
      return "read";
    default:
      return "none";
  }
}

/**
 * The role of the token's *own* owner on a repo, read from the repository's
 * `permissions` block. Works for any collaborator inspecting their own access
 * (no push permission required), which is what the dashboard/issue-opener gate
 * needs. Returns "none" on any failure.
 */
export async function getTokenRepoRole(
  token: string,
  repoFullName: string,
): Promise<RepoRole> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) return "none";
    const repo = (await res.json()) as {
      permissions?: {
        admin?: boolean;
        maintain?: boolean;
        push?: boolean;
        triage?: boolean;
        pull?: boolean;
      };
    };
    const p = repo.permissions;
    if (!p) return "none";
    if (p.admin) return "admin";
    if (p.maintain) return "maintain";
    if (p.push) return "write";
    if (p.triage) return "triage";
    if (p.pull) return "read";
    return "none";
  } catch {
    return "none";
  }
}

/** Whether the token owner has maintainer+ access on the repo. */
export async function tokenHasMaintainerAccess(
  token: string,
  repoFullName: string,
): Promise<boolean> {
  return isMaintainerRole(await getTokenRepoRole(token, repoFullName));
}

/**
 * The role of an arbitrary collaborator (`username`) on a repo, via the
 * collaborator-permission endpoint. The token must itself have push access to
 * the repo to read this — pass a bot/installation (or service) token. Used to
 * verify that whoever approved a pending run is a maintainer. Returns "none" on
 * any failure.
 */
export async function getUserRepoRole(
  token: string,
  repoFullName: string,
  username: string,
): Promise<RepoRole> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/collaborators/${encodeURIComponent(
        username,
      )}/permission`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return "none";
    // `role_name` is the granular role (admin/maintain/write/triage/read);
    // `permission` is the coarse legacy field. Prefer the former.
    const data = (await res.json()) as {
      role_name?: string;
      permission?: string;
    };
    return toRepoRole(data.role_name ?? data.permission);
  } catch {
    return "none";
  }
}

/** Whether `username` has maintainer+ access on the repo (read with `token`). */
export async function userHasMaintainerAccess(
  token: string,
  repoFullName: string,
  username: string,
): Promise<boolean> {
  return isMaintainerRole(await getUserRepoRole(token, repoFullName, username));
}

export interface CommentReaction {
  /** The reaction emoji content, e.g. "+1", "heart", "hooray", "rocket". */
  content: string;
  /** The login of the user who reacted. */
  userLogin: string;
}

// Reactions we treat as an affirmative approval. "-1" (👎) is deliberately not
// here — it's handled separately as a denial.
const APPROVAL_REACTIONS: ReadonlySet<string> = new Set([
  "+1",
  "heart",
  "hooray",
  "rocket",
]);

/** Whether a reaction content counts as an approval. */
export function isApprovalReaction(content: string): boolean {
  return APPROVAL_REACTIONS.has(content);
}

/**
 * Lists the reactions on an issue comment. Best-effort: returns [] on any error
 * so a failed lookup is simply treated as "no approving reaction yet".
 */
export async function listIssueCommentReactions(
  token: string,
  repoFullName: string,
  commentId: string | number,
): Promise<CommentReaction[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/comments/${commentId}/reactions?per_page=100`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return [];
    const raw = (await res.json()) as {
      content: string;
      user: { login: string } | null;
    }[];
    return raw
      .filter((r) => r.user?.login)
      .map((r) => ({ content: r.content, userLogin: r.user!.login }));
  } catch {
    return [];
  }
}
