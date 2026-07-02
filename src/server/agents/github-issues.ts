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

/**
 * Whether a GitHub PR or issue is open, closed, or (PRs only) merged.
 * "completed" is a closed issue that was resolved as done (e.g. closed by a
 * pull request); it's distinct from "closed", which means closed as not
 * planned. Surfacing the distinction lets the UI show success iconography for
 * issues that were actually completed rather than a failure-style red x.
 */
export type GithubItemState = "open" | "closed" | "completed" | "merged";

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
  // GitHub sets this to "completed" when an issue is closed as done (including
  // when closed by a linked pull request) and "not_planned" otherwise.
  state_reason?: string | null;
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
      state =
        data.state === "closed"
          ? data.state_reason === "completed"
            ? "completed"
            : "closed"
          : "open";
    }
    stateCache.set(url, { state, at: Date.now() });
    return state;
  } catch {
    return cached?.state ?? null;
  }
}

/**
 * The refs a resumed run needs to continue a pull request: the head branch to
 * push follow-up commits to and the base its PR targets. `headRepoFullName`
 * lets callers refuse cross-fork PRs (we can't push to a fork the run's token
 * doesn't own). Null on any lookup failure.
 */
export interface PullRequestRefs {
  headRef: string;
  baseRef: string;
  headRepoFullName: string | null;
  state: "open" | "closed";
  merged: boolean;
}

/** Fetches a pull request's head/base refs and state. Null on any failure. */
export async function getPullRequestRefs(
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<PullRequestRefs | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      state: string;
      merged_at: string | null;
      head: { ref: string; repo: { full_name: string } | null };
      base: { ref: string };
    };
    return {
      headRef: data.head.ref,
      baseRef: data.base.ref,
      headRepoFullName: data.head.repo?.full_name ?? null,
      state: data.state === "closed" ? "closed" : "open",
      merged: !!data.merged_at,
    };
  } catch {
    return null;
  }
}

/** Posts a comment on a GitHub issue. Throws on a non-2xx response. */
export async function postIssueComment(
  token: string,
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        ...ghHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
}

/**
 * Posts a comment on a GitHub issue and returns the created comment's numeric
 * id (needed to later read reactions on it for the approval flow). Throws on a
 * non-2xx response.
 */
export async function postIssueCommentReturningId(
  token: string,
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<number> {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        ...ghHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}

/** A reaction on an issue comment, with the reacting user's login. */
export interface CommentReaction {
  content: string;
  user: { login: string } | null;
}

/**
 * Lists the reactions on an issue comment, each with the reacting user's login.
 * Used by the approval flow to find a maintainer's 👍 / 🚀 on the bot's
 * approval-request comment. Throws on a non-2xx response.
 */
export async function listCommentReactions(
  token: string,
  repoFullName: string,
  commentId: number,
): Promise<CommentReaction[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/issues/comments/${commentId}/reactions`,
    {
      headers: {
        ...ghHeaders(token),
        Accept: "application/vnd.github.squirrel-girl-preview+json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as CommentReaction[];
}

/** A token to try when posting a bot-voice comment, labeled for diagnostics. */
export interface CommentTokenCandidate {
  token: string | null | undefined;
  /** Where the token came from, e.g. "app-installation" — used only in logs. */
  source: string;
}

/**
 * Posts an issue comment, trying each candidate token in order until one
 * succeeds. Bot-voice callers ("🤖 Bando picked up this issue…") pass only the
 * GitHub App installation token, so the comment is always attributed to
 * bandolier[bot] and never to a human or a generic service user — a message that
 * speaks in the bot's voice but is attributed to anyone else is misleading. When
 * the App installation can't post (e.g. it isn't installed, or lacks
 * Issues:write), the comment is skipped rather than posted under another
 * credential. Each failed attempt is logged so a misconfigured App is
 * diagnosable. Returns the source that succeeded, or null if none could post.
 */
export async function postIssueCommentWithFallback(
  candidates: CommentTokenCandidate[],
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<string | null> {
  // De-dupe identical tokens (e.g. when the legacy PAT and user token match) so
  // we don't retry a credential that already failed.
  const tried = new Set<string>();
  for (const { token, source } of candidates) {
    if (!token || tried.has(token)) continue;
    tried.add(token);
    try {
      await postIssueComment(token, repoFullName, issueNumber, body);
      return source;
    } catch (err) {
      console.warn("[bandolier:github] issue comment attempt failed", {
        repo: repoFullName,
        issue: issueNumber,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
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
