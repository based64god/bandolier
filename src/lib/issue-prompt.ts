// Single source of truth for the issue-mode prompt, shared by the server (which
// sets it as the agent's CLAUDE_TASK) and the deploy modal's preview tooltip.
// The harness keeps a Go copy of buildIssueTask as a fallback — keep in sync.

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

/** Builds the full prompt sent to Claude for a GitHub issue task. */
export function buildIssuePrompt(
  issue: { number: number; title: string; body: string },
  branch: string,
  extraContext: string,
): string {
  const body = issue.body.trim() || "(no description provided)";

  let task = `You are an AI agent working on GitHub issue #${issue.number}.

## Issue #${issue.number}: ${issue.title}

${body}

## Your objective

Implement a complete solution for this issue.

The repository has been cloned. You are on branch "${branch}" — do not switch branches.

Steps:
1. Explore the codebase to understand the existing patterns
2. Implement a working solution for the issue
3. Commit all changes:
   git add -A
   git commit -m "${issue.title}"

Do NOT push or open a pull request — the harness will do that once you finish.
Do not ask for clarification. Implement the best solution you can.`;

  const ctx = extraContext.trim();
  if (ctx) {
    task += `\n\n## Additional context from the operator\n\n${ctx}`;
  }
  return task;
}
