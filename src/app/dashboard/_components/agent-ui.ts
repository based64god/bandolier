// Shared presentation helpers for agent tables (per-repo view + overview panel).

import type { GithubItemState } from "~/server/agents/github-issues";

export const STATUS_STYLES: Record<string, string> = {
  // Classic palette: a running agent is blue (in-flight), a finished one green.
  Running: "border-blue-500/40 bg-blue-500/20 text-blue-300",
  Pending: "border-yellow-500/40 bg-yellow-500/20 text-yellow-300",
  Failed: "border-red-500/40 bg-red-500/20 text-red-300",
  Succeeded: "border-green-500/40 bg-green-500/20 text-green-300",
  Unknown: "border-gray-500/40 bg-gray-500/20 text-gray-400",
};

// Statuses that read better as motion than a static glyph. An in-flight agent
// renders as a small spinner (the old blue "Running" pill) so the activity is
// visible at a glance; everything else keeps its fixed icon.
export const SPINNER_STATUSES = new Set(["Running"]);

// Single-path glyphs (Heroicons mini, 20×20 viewBox, fill-rule evenodd) that
// mirror each status. They let the status pill collapse from text to comparable
// iconography when horizontal space is tight (e.g. narrow/mobile viewports),
// where the pill colour already carries most of the meaning.
export const STATUS_ICON_PATHS: Record<string, string> = {
  // Solid disc — an active, in-flight agent.
  Running: "M10 2a8 8 0 100 16 8 8 0 000-16z",
  // Clock — queued, not yet started.
  Pending:
    "M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z",
  // X in a circle — errored out.
  Failed:
    "M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z",
  // Check in a circle — finished cleanly.
  Succeeded:
    "M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z",
  // Minus in a circle — indeterminate.
  Unknown:
    "M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z",
};

// Terminal pod phases — the agent has finished and won't change further.
const DONE_STATUSES = new Set(["Succeeded", "Failed"]);

/** Whether an agent has finished running (so it can sink to the bottom). */
export function isAgentDone(status: string): boolean {
  return DONE_STATUSES.has(status);
}

/**
 * Whether a task's output has reached a terminal state on GitHub: a merged or
 * closed pull request, or a closed/completed created issue. Tasks with no output
 * yet, or whose output is still open, are not resolved. Mirrors OutputBadge's
 * precedence — a created issue stands in for the output when present, otherwise
 * the pull request — so the filter matches the badge a user sees on the row.
 */
export function isAgentOutputResolved(agent: {
  pullRequestUrl: string | null;
  pullRequestState: GithubItemState | null;
  createdIssueUrl: string | null;
  createdIssueState: GithubItemState | null;
}): boolean {
  if (agent.createdIssueUrl) {
    return (
      agent.createdIssueState != null && agent.createdIssueState !== "open"
    );
  }
  if (agent.pullRequestUrl) {
    return agent.pullRequestState != null && agent.pullRequestState !== "open";
  }
  return false;
}

/**
 * The text to show in the hover tooltip for a task's name cell. The cell renders
 * `displayName`, which for an ad-hoc task is only a 60-char preview of the prompt
 * (server-truncated with an ellipsis) — so on hover we surface the full prompt
 * instead. Issue tasks show `#N: title`, which is already untruncated, and their
 * `prompt` is the entire issue body (not a longer form of the label), so those
 * keep the label.
 */
export function taskNameTooltip(agent: {
  displayName: string;
  prompt: string | null;
  issueNumber: string | null;
}): string {
  if (!agent.issueNumber && agent.prompt) return agent.prompt;
  return agent.displayName;
}

// When the finished job will be garbage-collected, shown as a local clock time
// (e.g. "3:25 PM"). Null/running → "—"; an already-passed expiry → "expiring…".
// The date is appended when the expiry doesn't fall on the current local day, so
// far-off times aren't mistaken for today.
export function expiresAtLocal(expiresAt: string | null): string {
  if (!expiresAt) return "—";
  const when = new Date(expiresAt);
  if (when.getTime() <= Date.now()) return "expiring…";
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  const time = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (sameDay) return time;
  const date = when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date}, ${time}`;
}
