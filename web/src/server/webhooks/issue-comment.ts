import { resumeFromComment } from "./comment-resume";
import { type IssueCommentPayload, type WebhookRunConfig } from "./types";

/**
 * An `issue_comment` event: a vanilla comment on an issue or, via the same
 * event, on a pull request (GitHub delivers PR conversation comments here with
 * `issue.pull_request` set). Normalizes the payload and hands off to
 * `resumeFromComment`, which resumes the item's most recent run.
 */
export async function handleIssueComment(
  payload: IssueCommentPayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { issue, comment, repository } = payload;
  const isPullRequest = !!issue.pull_request;
  await resumeFromComment(
    {
      kind: isPullRequest ? "pull request" : "issue",
      isPullRequest,
      number: issue.number,
      title: issue.title,
      labels: issue.labels,
      htmlUrl: issue.html_url,
      pullRequestUrl: issue.pull_request?.html_url ?? null,
      repository,
      user: comment.user,
      body: comment.body ?? "",
    },
    config,
  );
}
