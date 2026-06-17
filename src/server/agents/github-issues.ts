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

/** Whether a GitHub PR or issue is open, closed, or (PRs only) merged. */
export type GithubItemState = "open" | "closed" | "merged";

interface GithubRef {
  owner: string;
  repo: string;
  number: number;
  kind: "pull" | "issue";
}

/** Parses owner/repo/number/kind out of a GitHub PR or issue html URL. */
function parseGithubRef(url: string): GithubRef | null {
  const m = /github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/.exec(url);
  if (!m) return null;
  return {
    owner: m[1]!,
    repo: m[2]!,
    kind: m[3] === "pull" ? "pull" : "issue",
    number: Number(m[4]),
  };
}

// The dashboard polls every few seconds; cache item states briefly to keep the
// GitHub API call count bounded. Merged PRs are terminal, so they never expire.
const STATE_CACHE_TTL_MS = 60_000;
const stateCache = new Map<string, { state: GithubItemState; at: number }>();

interface RawPull {
  state: string;
  merged_at: string | null;
}

interface RawIssueState {
  state: string;
}

/**
 * Resolves whether the PR or issue at a GitHub html URL is open, closed, or
 * (for PRs) merged. Returns null when the URL isn't a recognizable GitHub
 * PR/issue link or on a transient API failure — callers then fall back to
 * showing the badge without a state indicator. Results are cached briefly so
 * the frequent dashboard polling doesn't exhaust the GitHub rate limit.
 */
export async function getGithubItemState(
  token: string,
  url: string,
): Promise<GithubItemState | null> {
  const ref = parseGithubRef(url);
  if (!ref) return null;

  const cached = stateCache.get(url);
  if (
    cached &&
    (cached.state === "merged" || Date.now() - cached.at < STATE_CACHE_TTL_MS)
  ) {
    return cached.state;
  }

  try {
    const endpoint = ref.kind === "pull" ? "pulls" : "issues";
    const res = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/${endpoint}/${ref.number}`,
      { headers: ghHeaders(token) },
    );
    // On a failed lookup, keep showing the last known state if we have one.
    if (!res.ok) return cached?.state ?? null;

    let state: GithubItemState;
    if (ref.kind === "pull") {
      const data = (await res.json()) as RawPull;
      state = data.merged_at
        ? "merged"
        : data.state === "closed"
          ? "closed"
          : "open";
    } else {
      const data = (await res.json()) as RawIssueState;
      state = data.state === "closed" ? "closed" : "open";
    }
    stateCache.set(url, { state, at: Date.now() });
    return state;
  } catch {
    return cached?.state ?? null;
  }
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
