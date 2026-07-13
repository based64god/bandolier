import { resumeFromComment } from "./comment-resume";
import {
  type PullRequestReviewCommentPayload,
  type WebhookRunConfig,
} from "./types";

/**
 * A `pull_request_review_comment` event: an inline comment on a specific line
 * of a PR's diff. Resumes the PR's most recent run exactly like a vanilla
 * comment does, additionally passing the file/line the comment is anchored to
 * so the resumed run knows which code the reviewer is pointing at.
 */
export async function handlePrReviewComment(
  payload: PullRequestReviewCommentPayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { comment, pull_request: pr, repository } = payload;
  await resumeFromComment(
    {
      kind: "pull request",
      isPullRequest: true,
      number: pr.number,
      title: pr.title,
      labels: pr.labels,
      htmlUrl: pr.html_url,
      pullRequestUrl: pr.html_url,
      repository,
      user: comment.user,
      body: comment.body ?? "",
      reviewComment: {
        path: comment.path,
        line: comment.line,
        startLine: comment.start_line,
        diffHunk: comment.diff_hunk,
      },
    },
    config,
  );
}
