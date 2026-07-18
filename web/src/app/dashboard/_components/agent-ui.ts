// Shared presentation helpers for agent tables (per-repo view + overview panel).

import type { GithubItemState } from "~/server/agents/github-issues";

export const STATUS_STYLES: Record<string, string> = {
  // Classic palette: a running agent is blue (in-flight), a finished one green.
  Running: "border-blue-500/40 bg-blue-500/20 text-blue-300",
  Pending: "border-yellow-500/40 bg-yellow-500/20 text-yellow-300",
  Failed: "border-red-500/40 bg-red-500/20 text-red-300",
  Succeeded: "border-green-500/40 bg-green-500/20 text-green-300",
  Unknown: "border-gray-500/40 bg-gray-500/20 text-gray-400",
  // Client-only, optimistic statuses shown while the user's create/delete
  // request propagates through Kubernetes (the list only refreshes once the
  // cluster reflects it). "Deploying" fronts a just-submitted task before its
  // pod appears; "Terminating" marks a row whose deletion has been requested but
  // whose pod is still winding down; "Finalizing" marks an interactive session
  // whose end-session request is being processed (committing, opening a PR)
  // while the pod is still Running. All spin (see SPINNER_STATUSES).
  Deploying: "border-purple-500/40 bg-purple-500/20 text-purple-300",
  Terminating: "border-orange-500/40 bg-orange-500/20 text-orange-300",
  Finalizing: "border-sky-500/40 bg-sky-500/20 text-sky-300",
};

// Statuses that read better as motion than a static glyph. An in-flight agent
// renders as a small spinner (the old blue "Running" pill) so the activity is
// visible at a glance; everything else keeps its fixed icon.
export const SPINNER_STATUSES = new Set([
  "Running",
  // Optimistic in-flight states: the request is propagating through the cluster.
  "Deploying",
  "Terminating",
  "Finalizing",
]);

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
 * Whether a task's output is still open on GitHub: an open created issue, or an
 * open pull request when there's no created issue. Mirrors `isAgentOutputResolved`'s
 * precedence (created issue stands in for the output when present, otherwise the
 * pull request) so the two agree on which output a task is judged by.
 */
export function isAgentOutputOpen(agent: {
  pullRequestUrl: string | null;
  pullRequestState: GithubItemState | null;
  createdIssueUrl: string | null;
  createdIssueState: GithubItemState | null;
}): boolean {
  if (agent.createdIssueUrl) return agent.createdIssueState === "open";
  if (agent.pullRequestUrl) return agent.pullRequestState === "open";
  return false;
}

/**
 * Whether a task counts as "resolved" for the "Hide resolved" table filter.
 * That's either its output having reached a terminal state on GitHub (see
 * `isAgentOutputResolved`), or a task that has finished and since expired: its
 * pod is gone (Job TTL) and there's nothing left to act on, so it's just as done
 * as a merged PR even when it produced no GitHub output to resolve. This holds
 * whether the task succeeded or failed — a failed, expired task is equally done.
 *
 * A still-open issue or PR overrides both: an expired task whose output is still
 * open has something left to act on, so it stays unresolved and isn't hidden.
 */
export function isAgentResolved(agent: {
  status: string;
  expired: boolean;
  pullRequestUrl: string | null;
  pullRequestState: GithubItemState | null;
  createdIssueUrl: string | null;
  createdIssueState: GithubItemState | null;
}): boolean {
  if (isAgentOutputOpen(agent)) return false;
  if (isAgentDone(agent.status) && agent.expired) return true;
  return isAgentOutputResolved(agent);
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

/**
 * The text to render in a task's name cell. An ad-hoc task's `displayName` is
 * only a 60-char preview of the prompt (server-truncated with an ellipsis), so
 * rendered as-is it stops well short of a wide Task column's edge. When the
 * label is exactly that preview, render the full prompt instead and let the
 * cell's own CSS truncation fit it to the actual column width. The prefix check
 * keeps deliberate labels intact: issue tasks (`#N: title`) and tasks renamed
 * via the API don't match the preview shape, so they keep their `displayName`.
 */
export function taskNameLabel(agent: {
  displayName: string;
  prompt: string | null;
  issueNumber: string | null;
}): string {
  const { displayName, prompt, issueNumber } = agent;
  if (
    !issueNumber &&
    prompt &&
    displayName.endsWith("…") &&
    prompt.startsWith(displayName.slice(0, -1))
  ) {
    return prompt;
  }
  return displayName;
}

/**
 * Picks the next session for Tab to jump to when cycling through the tasks
 * awaiting input. `names` is the awaiting sessions in table order; `current` is
 * the one Tab last landed on (or null/unknown). `direction` is +1 for Tab
 * (forward) or -1 for Shift+Tab (backward). Returns the target name, wrapping
 * around either end, or null when nothing is waiting.
 *
 * A `current` that's no longer waiting (resolved since, so absent from `names`)
 * — or null — has no position in the list, so the cycle restarts at the natural
 * end for the direction: the first entry going forward, the last going backward.
 */
export function nextAwaitingTarget(
  names: string[],
  current: string | null,
  direction: 1 | -1 = 1,
): string | null {
  const len = names.length;
  if (len === 0) return null;
  const idx = current ? names.indexOf(current) : -1;
  // No current position: forward starts at the top, backward at the bottom.
  if (idx === -1) return direction === 1 ? names[0]! : names[len - 1]!;
  // +len keeps the operand non-negative before the modulo so backward wrapping
  // (idx 0, direction -1) lands on the last entry rather than a negative index.
  return names[(idx + direction + len) % len]!;
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

// A compact relative label ("just now", "5m ago", "3h ago", "2d ago") for the
// footer's credential-usage indicators. Accepts a Date (SuperJSON preserves it
// over the wire) or an ISO string. Future timestamps read as "just now".
export function usedAgoLabel(when: Date | string): string {
  const then = typeof when === "string" ? new Date(when) : when;
  const mins = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// The subscription-usage meter reading the footer renders: how full the
// rolling-window allowance is (0–100), and a tone that shades the bar as it
// nears the cap. Pure so it's unit-tested and shared by the dev harness.
export function usageMeter(
  runs: number,
  budget: number,
): { pct: number; tone: "ok" | "warn" | "max" } {
  const pct = budget <= 0 ? 0 : Math.min(100, Math.round((runs / budget) * 100));
  const tone = pct >= 90 ? "max" : pct >= 70 ? "warn" : "ok";
  return { pct, tone };
}

// A compact "resets in …" label for a subscription window's reset time. Accepts
// a Date (SuperJSON preserves it) or an ISO string; a window already past due
// reads as "resetting…".
export function resetsInLabel(when: Date | string): string {
  const then = typeof when === "string" ? new Date(when) : when;
  const mins = Math.round((then.getTime() - Date.now()) / 60_000);
  if (mins <= 0) return "resetting…";
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.round(mins / 60);
  return `resets in ${hours}h`;
}

// Mirrors the `failure` field podToTask distills from a Failed pod's status.
export interface TaskFailure {
  reason: string;
  exitCode: number | null;
  message: string | null;
}

export interface FailureExplanation {
  /** Short headline, e.g. "Out of memory". */
  title: string;
  /** What happened, in plain language. */
  why: string;
  /** What the user can do about it. */
  fix: string;
}

const CHECK_LOGS_FIX =
  "Open the task's logs (tap the row) to see its last output before it died.";
const RAISE_MEMORY_FIX =
  "Retry with a higher memory limit: set Memory when creating the task, or " +
  "raise the default under Settings → Agent compute (or the repo's config).";

/**
 * Turns the raw Kubernetes failure detail into a human explanation and a
 * suggested fix, shown when the user taps a Failed status badge. A bare
 * "Failed" pill tells the user nothing — an OOM kill in particular has a
 * one-line remedy (raise the memory limit) they can't discover from the logs,
 * which just stop mid-run.
 */
export function explainFailure(failure: TaskFailure): FailureExplanation {
  const { reason, exitCode, message } = failure;

  if (reason === "OOMKilled") {
    return {
      title: "Out of memory",
      why: "The agent used more memory than the pod's limit allows, so Kubernetes killed it (OOMKilled).",
      fix: RAISE_MEMORY_FIX,
    };
  }

  if (reason === "Evicted") {
    return {
      title: "Evicted",
      why:
        message ??
        "The node ran short of resources and Kubernetes evicted the pod.",
      fix: "Retry the task — evictions are usually transient node pressure. If it keeps happening, ask your cluster admin about capacity.",
    };
  }

  if (reason === "DeadlineExceeded") {
    return {
      title: "Deadline exceeded",
      why: "The job ran longer than its allowed deadline and was terminated.",
      fix: "Retry the task; if it keeps timing out, split the work into smaller tasks.",
    };
  }

  // SIGKILL without an explicit OOMKilled reason — most often still the
  // out-of-memory killer, just reported by the node rather than the cgroup.
  if (exitCode === 137) {
    return {
      title: "Killed",
      why: "The agent was force-killed (exit code 137, SIGKILL) — usually the out-of-memory killer when the pod hits its memory limit.",
      fix: RAISE_MEMORY_FIX,
    };
  }

  if (exitCode !== null) {
    return {
      title: `Exited with code ${exitCode}`,
      why: message ?? "The agent process crashed or exited with an error.",
      fix: CHECK_LOGS_FIX,
    };
  }

  return {
    title: reason,
    why: message ?? "The pod failed without reporting a specific cause.",
    fix: CHECK_LOGS_FIX,
  };
}
