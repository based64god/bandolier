import { type RepoWebhookConfig } from "~/server/agents/webhook-config";

// The repo config a run-spawning handler reads. Passed as one object (rather
// than as positional nullable arguments) so transposing two `string | null`
// fields can't silently type-check. `getRepoWebhookConfig` may find no config
// row, so the whole object is nullable and the handlers default each field.
export type WebhookRunConfig = Pick<
  RepoWebhookConfig,
  | "prefix"
  | "triggerOnAllEvents"
  | "agentImage"
  | "defaultWebhookModel"
  | "reviewModel"
  | "defaultWebhookEffort"
  | "systemPrompt"
  | "networkPolicy"
  | "hasArtifactStore"
> | null;

// ── GitHub webhook payload types ──────────────────────────────────────────────
//
// Hand-rolled subsets of the GitHub webhook event payloads — only the fields the
// handlers read. Shared by the route (which narrows on `event` + `action`) and
// the per-event handler modules in this directory.

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
}

export interface GitHubRepository {
  full_name: string;
  clone_url: string;
  default_branch: string;
}

export interface IssuePayload {
  action: string;
  issue: GitHubIssue;
  repository: GitHubRepository;
  sender: { id: number; login: string };
  // Present on the `edited` action: the prior values of the fields that
  // changed. Only the changed fields appear, so an unchanged title/body is
  // absent here and its current value still reflects the pre-edit state.
  changes?: {
    title?: { from: string };
    body?: { from: string | null };
  };
}

// `issue_comment` event: a comment on an issue — or on a pull request, which
// GitHub delivers through the same event with `issue.pull_request` set. Drives
// both resuming a run by commenting and the maintainer approval flow for held,
// credential-gated runs.
export interface IssueCommentPayload {
  action: string;
  issue: GitHubIssue & { pull_request?: { html_url: string } };
  comment: {
    id: number;
    body: string | null;
    user: { id: number; login: string; type?: string };
  };
  repository: GitHubRepository;
  sender: { id: number; login: string };
}

// `pull_request_review_comment` event: an inline comment left on a specific
// line of a pull request's diff (the review-comment thread), delivered
// separately from the `issue_comment` event that carries vanilla PR comments.
// The `comment` fields beyond `body`/`user` locate the comment in the diff
// (file path, line range, side, and the surrounding hunk) so the resumed run
// knows which code the reviewer is pointing at.
export interface PullRequestReviewCommentPayload {
  action: string;
  comment: {
    id: number;
    body: string | null;
    user: { id: number; login: string; type?: string };
    path: string;
    // The line the comment targets in the file's new (`RIGHT`) or old (`LEFT`)
    // side. Null when the comment is on an outdated diff GitHub can't remap.
    line: number | null;
    // First line of a multi-line comment range; null for a single line.
    start_line: number | null;
    side: string | null;
    // The unified-diff hunk the comment was left on.
    diff_hunk: string | null;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    labels: { name: string }[];
  };
  repository: GitHubRepository;
  sender: { id: number; login: string };
}

// `pull_request` event: a PR was opened, marked ready for review, or had new
// commits pushed to its branch (synchronize), among other actions. Drives
// automatic PR reviews: `opened`/`ready_for_review` start a review, and
// `synchronize` re-reviews by resuming the PR's review run. Only the fields the
// review handlers read are modelled.
export interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: { name: string }[];
    // A draft PR isn't ready for review; a later `ready_for_review` clears this.
    draft?: boolean;
    user: { id: number; login: string; type?: string };
  };
  repository: GitHubRepository;
  // Who triggered the event: the opener for `opened`, the pusher for
  // `synchronize`. The run is owned by (and spends the credentials of) this user.
  sender: { id: number; login: string };
}

// Payloads for the GitHub App's lifecycle events, which maintain the
// repo → installation mapping the bot-token broker reads.
export interface InstallationRef {
  id: number;
  account: { login: string } | null;
}

// `installation` event: the App is installed/uninstalled, or repos are added to
// / removed from an existing installation (action "added"/"removed").
export interface InstallationPayload {
  action: string;
  installation: InstallationRef;
  // Present on install with "selected repositories" and on the "added" action.
  repositories?: { full_name: string }[];
  repositories_added?: { full_name: string }[];
  repositories_removed?: { full_name: string }[];
}

// `workflow_run` event: a GitHub Actions run (a CI pipeline) started, finished,
// or was requested. We act only on `completed` with a `failure` conclusion, to
// auto-resume the Bandolier run that produced the pull request the pipeline ran
// on. `pull_requests` is populated for same-repo PR runs (empty for forks and
// non-PR runs), and `head_sha` identifies the failing commit — used to bound
// how often a single PR auto-resumes.
export interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    name: string;
    head_branch: string;
    head_sha: string;
    conclusion: string | null;
    html_url: string;
    pull_requests: { number: number }[];
  };
  repository: GitHubRepository;
}
