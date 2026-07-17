// Single source of truth for the review-mode *user message* (the PR context
// passed as CLAUDE_TASK). Like issue-output mode, the harness builds the review
// framing (the system prompt) itself — see buildReviewOutputSystemPrompt in the
// harness — so this only carries the pull request the agent should review.

/**
 * Builds the user message for a PR-review run: the pull request's context
 * (number, title, description). The harness additionally fetches the diff with
 * `gh`, and frames the read-only review objective in the system prompt.
 */
export function buildReviewUserMessage(pr: {
  number: number;
  title: string;
  body: string;
}): string {
  const body = pr.body.trim() || "(no description provided)";
  return `## Pull request #${pr.number}: ${pr.title}

${body}`;
}

/**
 * Builds the user message for a re-review — a review resumed because the PR's
 * branch was updated (a `pull_request` synchronize). The harness prepends the
 * previous review run's transcript, so this only carries what's new: that the
 * PR has changed and the agent should review the update, focusing on whether
 * earlier feedback was addressed and on newly introduced problems.
 */
export function buildReReviewUserMessage(pr: {
  number: number;
  title: string;
}): string {
  return `## Pull request #${pr.number} was updated: ${pr.title}

New commits were pushed to this pull request since your previous review (included above). Re-review the pull request as it now stands: fetch the current diff with \`gh\`, check whether the points from your earlier review were addressed, and review any newly introduced changes. Do not repeat feedback that no longer applies.`;
}
