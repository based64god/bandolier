import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PullRequestReviewCommentPayload,
  WebhookRunConfig,
} from "~/server/webhooks/types";
import type { CommentResume } from "~/server/webhooks/comment-resume";

// handlePrReviewComment is a thin adapter: it normalizes the
// `pull_request_review_comment` payload into a CommentResume and delegates to
// the shared resumeFromComment core (exercised end-to-end in
// issue-comment.test.ts). Mock the core and assert the normalized input — the
// only new logic here is the field mapping and the review-comment metadata.

const resumeFromComment =
  vi.fn<(input: CommentResume, config: WebhookRunConfig) => Promise<void>>();
vi.mock("~/server/webhooks/comment-resume", () => ({
  resumeFromComment: (input: CommentResume, config: WebhookRunConfig) =>
    resumeFromComment(input, config),
}));

const { handlePrReviewComment } =
  await import("~/server/webhooks/pr-review-comment");

const REPO = {
  full_name: "acme/widgets",
  clone_url: "https://github.com/acme/widgets.git",
  default_branch: "main",
};

const CONFIG = { hasArtifactStore: true } as unknown as WebhookRunConfig;

function payload(
  overrides: {
    body?: string | null;
    line?: number | null;
    start_line?: number | null;
    diff_hunk?: string | null;
    user?: { id: number; login: string; type?: string };
    pull_request_review_id?: number | null;
  } = {},
): PullRequestReviewCommentPayload {
  return {
    action: "created",
    comment: {
      id: 5,
      body: "body" in overrides ? overrides.body! : "please tweak this line",
      user: overrides.user ?? { id: 42, login: "octocat", type: "User" },
      pull_request_review_id: overrides.pull_request_review_id ?? 900,
      path: "src/auth.ts",
      line: overrides.line ?? 42,
      start_line: overrides.start_line ?? null,
      side: "RIGHT",
      diff_hunk: overrides.diff_hunk ?? "@@ -40,3 +40,4 @@\n+  return u;",
    },
    pull_request: {
      number: 7,
      title: "Add login",
      html_url: "https://github.com/acme/widgets/pull/7",
      labels: [{ name: "model:opus" }],
    },
    repository: REPO,
    sender: { id: 42, login: "octocat" },
  };
}

function resumeInput(): CommentResume {
  expect(resumeFromComment).toHaveBeenCalledTimes(1);
  return resumeFromComment.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resumeFromComment.mockResolvedValue(undefined);
});

describe("handlePrReviewComment", () => {
  it("normalizes the review comment as a pull-request resume", async () => {
    await handlePrReviewComment(payload(), CONFIG);

    const input = resumeInput();
    expect(input.kind).toBe("pull request");
    expect(input.isPullRequest).toBe(true);
    expect(input.number).toBe(7);
    expect(input.title).toBe("Add login");
    expect(input.labels).toEqual([{ name: "model:opus" }]);
    expect(input.htmlUrl).toBe("https://github.com/acme/widgets/pull/7");
    expect(input.pullRequestUrl).toBe("https://github.com/acme/widgets/pull/7");
    expect(input.repository).toBe(REPO);
    expect(input.user).toEqual({ id: 42, login: "octocat", type: "User" });
    expect(input.body).toBe("please tweak this line");
    // The review id is forwarded so a Bandolier review's own comments can be
    // recognized and skipped downstream.
    expect(input.reviewId).toBe(900);
    // Config is forwarded untouched.
    expect(resumeFromComment.mock.calls[0]![1]).toBe(CONFIG);
  });

  it("carries the file/line/hunk metadata for the resume message", async () => {
    await handlePrReviewComment(
      payload({ line: 44, start_line: 40, diff_hunk: "@@ -40 +40 @@\n+x" }),
      CONFIG,
    );

    expect(resumeInput().reviewComment).toEqual({
      path: "src/auth.ts",
      line: 44,
      startLine: 40,
      diffHunk: "@@ -40 +40 @@\n+x",
    });
  });

  it("coerces a null comment body to an empty string", async () => {
    await handlePrReviewComment(payload({ body: null }), CONFIG);
    expect(resumeInput().body).toBe("");
  });
});
