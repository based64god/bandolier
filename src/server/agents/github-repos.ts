import { repoToNamespace } from "./namespace";

export interface AccessibleRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  namespace: string;
  // Admin permission is what GitHub requires to manage webhooks.
  canManageWebhooks: boolean;
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

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    }

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
    canManageWebhooks: r.permissions?.admin === true,
  }));
}
