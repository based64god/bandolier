// Single source of truth for the issue-mode prompt, shared by the server (which
// sets the system prompt as CLAUDE_SYSTEM_PROMPT and the issue context as
// CLAUDE_TASK) and the deploy modal's preview tooltip. The harness keeps a Go
// copy of these builders as a fallback — keep in sync.

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
3. Commit all changes:
   git add -A
   git commit -s -m "${issue.title}"

Do NOT push or open a pull request — the harness will do that once you finish.
Do not ask for clarification. Implement the best solution you can.`;
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
