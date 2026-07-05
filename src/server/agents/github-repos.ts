import { getRepoAccess, ghFetch } from "./github-api";
import { repoToNamespace } from "./namespace";

export interface AccessibleRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  namespace: string;
  // Admin permission on the repo, which gates repo-scoped configuration
  // (trigger prefix, agent image, shared credentials).
  isAdmin: boolean;
}

interface GitHubRepo {
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  default_branch: string;
  clone_url: string;
  permissions?: { admin?: boolean };
}

const PER_PAGE = 100;
const MAX_PAGES = 10; // safety cap: up to 1000 repos

/**
 * Lists every repository the acting user can access via their GitHub OAuth
 * token. We include the organization_member affiliation so org repos — including
 * SSO-protected ones the token is authorized for — are returned, not just
 * personally owned / collaborated repos.
 */
export async function fetchAccessibleRepos(
  accessToken: string,
): Promise<AccessibleRepo[]> {
  const all: GitHubRepo[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL("https://api.github.com/user/repos");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("visibility", "all");
    url.searchParams.set(
      "affiliation",
      "owner,collaborator,organization_member",
    );

    const res = await ghFetch(url, accessToken);
    const batch = (await res.json()) as GitHubRepo[];
    all.push(...batch);

    // Last page reached when fewer than a full page is returned.
    if (batch.length < PER_PAGE) break;
  }

  return all.map((r) => ({
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    namespace: repoToNamespace(r.full_name),
    isAdmin: r.permissions?.admin === true,
  }));
}

/**
 * Whether the user (via their GitHub OAuth token) can reach the given repository
 * at all — i.e. GitHub returns the repo for that token. Used to gate access to a
 * repo's shared cluster/credentials so they're never handed to a non-member.
 * Fails closed (returns false) on any error.
 */
export async function userHasRepoAccess(
  token: string,
  repoFullName: string,
): Promise<boolean> {
  return (await getRepoAccess(token, repoFullName)).accessible;
}

/**
 * Whether the user (via their GitHub token) has admin on the repo. Gates the
 * repo-scoped configuration (trigger prefix, agent image, shared credentials).
 * Returns false on any API error so callers fail closed.
 */
export async function isRepoAdmin(
  token: string,
  repoFullName: string,
): Promise<boolean> {
  return (await getRepoAccess(token, repoFullName)).isAdmin;
}
