export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  body: string;
}

// The GitHub issues endpoint also returns pull requests; this field is present
// only on PRs, so we use it to filter them out.
interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  pull_request?: unknown;
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Lists open issues (excluding pull requests) for a repo. */
export async function listOpenIssues(
  token: string,
  repoFullName: string,
): Promise<GithubIssue[]> {
  const url = new URL(`https://api.github.com/repos/${repoFullName}/issues`);
  url.searchParams.set("state", "open");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("sort", "updated");

  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  const raw = (await res.json()) as RawIssue[];
  return raw
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      url: i.html_url,
      body: i.body ?? "",
    }));
}

/** Fetches a single issue, or null if not found. */
export async function getIssue(
  token: string,
  repoFullName: string,
  number: number,
): Promise<GithubIssue | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/issues/${number}`,
    { headers: ghHeaders(token) },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  const i = (await res.json()) as RawIssue;
  return {
    number: i.number,
    title: i.title,
    url: i.html_url,
    body: i.body ?? "",
  };
}
