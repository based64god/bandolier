// Single source of truth for the issue-mode prompt, shared by the server (which
// sets the system prompt as CLAUDE_SYSTEM_PROMPT and the issue context as
// CLAUDE_TASK) and the deploy modal's preview tooltip. The harness has no copy
// of these builders: it requires the server-supplied env and fails loudly if
// it's missing, so this is genuinely the only place the prompt is built.

function slugify(s: string): string {
  let slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Keep branch names short: a few words is plenty for context.
  if (slug.length > 24) slug = slug.slice(0, 24).replace(/-+$/, "");
  return slug || "task";
}

/** Stable branch shown in the deploy preview (no unique suffix). */
export function issuePreviewBranch(issueNumber: number, title: string): string {
  return `issue-${issueNumber}-${slugify(title)}`;
}

/**
 * The actual working branch: short, and made unique with a random suffix so
 * re-running on the same issue never collides with a previous run's branch.
 * Generate once on the server and pass it to the harness.
 */
export function makeIssueBranch(issueNumber: number, title: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${issuePreviewBranch(issueNumber, title)}-${suffix}`;
}

/**
 * Builds the system prompt for a GitHub issue task: the instructional framing
 * that surrounds the issue context (objective, branch rules, commit steps). The
 * issue itself is delivered separately as the user message (see
 * buildIssueUserMessage) and is referenced here only where an instruction needs
 * it (the working branch and the commit subject).
 */
export function buildIssueSystemPrompt(
  issue: { title: string },
  branch: string,
): string {
  return `You are an AI agent working on a GitHub issue. The issue is provided in the user message.

## Your objective

Implement a complete solution for the issue.

The repository has been cloned. You are on branch "${branch}" — do not switch branches.

Steps:
1. Explore the codebase to understand the existing patterns
2. Implement a working solution for the issue
3. Commit your work as a sequence of small, self-contained commits — one coherent step per commit, ordered so each builds on the last and, where practical, leaves the tree working — so a reviewer can read it commit-by-commit. Prefer several focused commits over one large squashed commit; a genuinely small change can be a single commit. Leave nothing uncommitted and sign off every commit:
   git add -A
   git commit -s -m "<concise summary of the step>"

Do NOT push or open a pull request — the harness will do that once you finish.
Do not ask for clarification. Implement the best solution you can.`;
}

/**
 * Builds the system prompt for a resumed run — a follow-up comment on the
 * issue or PR a previous run worked on. The parent run's transcript is folded
 * into the user message by the harness; this framing covers the branch rules.
 * `continuesBranch` says whether the run picks up the parent's existing branch
 * (an open PR the harness will push more commits to) or starts a fresh one.
 */
export function buildResumeSystemPrompt(
  branch: string,
  continuesBranch: boolean,
): string {
  const branchFraming = continuesBranch
    ? `The repository has been cloned. You are on branch "${branch}", which already contains the previous run's commits and has an open pull request — do not switch branches, and do not undo the earlier work unless the follow-up asks for it.`
    : `The repository has been cloned. You are on a fresh branch "${branch}" — do not switch branches.`;
  const publishFraming = continuesBranch
    ? `Do NOT push or open a pull request — the harness will push your commits onto the existing pull request once you finish.`
    : `Do NOT push or open a pull request — the harness will do that once you finish.`;

  return `You are an AI agent resuming earlier work. A previous agent run worked on this task; its transcript is included in the user message, followed by the follow-up request that triggered this run.

## Your objective

Implement what the follow-up request asks for, building on the previous run's work.

${branchFraming}

Steps:
1. Read the parent-run transcript to understand what was already done, and why
2. Explore the codebase where needed — the code is the source of truth, the transcript is history
3. Implement the follow-up request
4. Commit your work as a sequence of small, self-contained commits — one coherent step per commit, so the follow-up can be reviewed commit-by-commit. Prefer several focused commits over one large squashed commit; a genuinely small change can be a single commit. Leave nothing uncommitted and sign off every commit:
   git add -A
   git commit -s -m "<concise summary of the step>"

${publishFraming}
Do not ask for clarification. Implement the best solution you can.`;
}

/**
 * Builds the user message for a resumed run: the follow-up comment in its
 * issue/PR context. The harness prepends the parent run's transcript, so this
 * only needs to carry what's new.
 */
export function buildResumeUserMessage(opts: {
  kind: "issue" | "pull request";
  number: number;
  title: string;
  commenter: string;
  comment: string;
}): string {
  const body = opts.comment.trim() || "(empty comment)";
  return `## Follow-up on ${opts.kind} #${opts.number}: ${opts.title}

@${opts.commenter} commented:

${body}`;
}

/**
 * Builds the user message for a run auto-resumed by a failing CI pipeline: it
 * tells the agent which pipeline failed on the PR it produced and asks it to
 * investigate and push a fix. Like a comment resume, the harness prepends the
 * parent run's transcript, so this only carries what's new.
 */
export function buildCiResumeUserMessage(opts: {
  prNumber: number;
  title: string;
  workflowName: string;
  runUrl: string | null;
}): string {
  const link = opts.runUrl ? `\n\nFailed run: ${opts.runUrl}` : "";
  return `## CI failed on pull request #${opts.prNumber}: ${opts.title}

The **${opts.workflowName}** pipeline failed on this pull request's latest commit.${link}

Investigate why it failed and push a fix so the pipeline passes. Read the failing run's logs (e.g. via \`gh run view\`) to see what broke, reproduce the failure locally where you can, and address the root cause rather than papering over it. If the failure is unrelated to the changes on this branch, say so instead of forcing a fix.`;
}

/**
 * Builds the user message for a GitHub issue task: the issue context itself
 * (number, title, body) plus any operator-supplied context from the dashboard
 * task field. The surrounding instructions live in the system prompt (see
 * buildIssueSystemPrompt).
 */
export function buildIssueUserMessage(
  issue: { number: number; title: string; body: string },
  extraContext: string,
): string {
  const body = issue.body.trim() || "(no description provided)";

  let message = `## Issue #${issue.number}: ${issue.title}

${body}`;

  const ctx = extraContext.trim();
  if (ctx) {
    message += `\n\n## Additional context from the operator\n\n${ctx}`;
  }
  return message;
}
