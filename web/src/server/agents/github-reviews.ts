import { ghFetch } from "./github-api";

/**
 * The GitHub review verdict. A Bandolier review is bot-voice and typically a
 * plain COMMENT; the agent may escalate to REQUEST_CHANGES for blocking issues
 * or APPROVE, but COMMENT is the safe default (it never blocks a merge).
 */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** One inline review comment, anchored to a line of the PR's diff. */
export interface ReviewComment {
  /** Repo-relative path of the file the comment is on. */
  path: string;
  /** The line in the file's diff the comment targets (the last line of a range). */
  line: number;
  /** Diff side; defaults to RIGHT (the PR's new version). */
  side?: string;
  /** First line of a multi-line range; omit for a single-line comment. */
  startLine?: number;
  startSide?: string;
  body: string;
}

/** A structured PR review: an overall body, a verdict, and inline comments. */
export interface PullRequestReviewInput {
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

/** Maps one inline comment to the GitHub reviews-API comment shape. */
function toApiComment(c: ReviewComment): Record<string, unknown> {
  const side = c.side ?? "RIGHT";
  return {
    path: c.path,
    line: c.line,
    side,
    ...(c.startLine
      ? { start_line: c.startLine, start_side: c.startSide ?? side }
      : {}),
    body: c.body,
  };
}

/** A posted review: its GitHub numeric id and the html_url to link to it. */
export interface PostedReview {
  id: string;
  url: string;
}

/**
 * Submits a pull-request review via the GitHub reviews API and returns the
 * created review's id and html_url. The caller passes the token that decides
 * attribution: the GitHub App installation token (bandolier[bot], for webhook
 * reviews) or the acting user's token (for dashboard reviews).
 *
 * Inline comments must anchor to lines in the PR's diff; if any don't, GitHub
 * rejects the whole review (422). Rather than lose the review, this retries with
 * the summary body only (dropping the inline comments) so the feedback still
 * lands. Throws when even the body-only review fails.
 */
export async function submitPullRequestReview(
  token: string,
  repoFullName: string,
  prNumber: number,
  review: PullRequestReviewInput,
): Promise<PostedReview> {
  const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/reviews`;
  const post = async (withComments: boolean): Promise<PostedReview> => {
    const res = await ghFetch(url, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: review.body,
        event: review.event,
        ...(withComments && review.comments.length > 0
          ? { comments: review.comments.map(toApiComment) }
          : {}),
      }),
    });
    const data = (await res.json()) as { id: number; html_url: string };
    return { id: String(data.id), url: data.html_url };
  };

  if (review.comments.length === 0) return post(false);
  try {
    return await post(true);
  } catch (err) {
    console.warn(
      "[bandolier:review] inline comments rejected — retrying body-only",
      {
        repo: repoFullName,
        pr: prNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return post(false);
  }
}
