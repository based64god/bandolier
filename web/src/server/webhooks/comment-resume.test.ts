import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobSpec } from "~/server/agents/create-job";
import type { CommentResume } from "~/server/webhooks/comment-resume";
import type { WebhookRunConfig } from "~/server/webhooks/types";

// Focused coverage for resumeFromComment's guard that a Bandolier review's own
// inline comments never resume anything. Bot-voice reviews are caught by the
// bot-login filter; a dashboard review is posted in the user's voice, so its
// comments look human and must be recognized by the review id we recorded
// posting (task_run.posted_review_id). The DB is a FIFO stub so the suppression
// lookup and the (later) parent lookup can be distinguished by call order.

const createAgentJob = vi.fn<(spec: JobSpec) => Promise<string>>();
vi.mock("~/server/agents/create-job", () => ({
  createAgentJob: (spec: JobSpec) => createAgentJob(spec),
}));

const resolveWebhookRun = vi.fn<() => Promise<unknown>>();
vi.mock("~/server/webhooks/resolve-run", () => ({
  resolveWebhookRun: () => resolveWebhookRun(),
}));

vi.mock("~/server/agents/github-issues", () => ({
  getPullRequestRefs: vi.fn(),
}));
vi.mock("~/server/agents/github-app", () => ({
  getRegistryPullSecret: vi.fn(() => undefined),
}));
vi.mock("~/server/webhooks/bot-ack", () => ({ postBotAck: vi.fn() }));
vi.mock("~/env", () => ({ env: { BETTER_AUTH_URL: "http://test.local" } }));

// FIFO select results: the suppression lookup consumes the first, the parent
// lookup the second. `dbSelect` is a spy so a test can assert how many selects
// ran (one = suppressed before the parent lookup; two = it proceeded).
const selectRows: unknown[][] = [];
const dbSelect = vi.fn(() => ({
  from: () => ({
    where: () => ({
      orderBy: () => ({ limit: () => Promise.resolve(selectRows.shift() ?? []) }),
      limit: () => Promise.resolve(selectRows.shift() ?? []),
    }),
  }),
}));
vi.mock("~/server/db", () => ({ db: { select: () => dbSelect() } }));

const { resumeFromComment } = await import("~/server/webhooks/comment-resume");

const CONFIG = {
  prefix: null,
  triggerOnAllEvents: true,
  hasArtifactStore: true,
} as unknown as WebhookRunConfig;

function reviewCommentResume(reviewId: number | null): CommentResume {
  return {
    kind: "pull request",
    isPullRequest: true,
    number: 7,
    title: "Add login",
    labels: [],
    htmlUrl: "https://github.com/acme/widgets/pull/7",
    pullRequestUrl: "https://github.com/acme/widgets/pull/7",
    repository: {
      full_name: "acme/widgets",
      clone_url: "https://github.com/acme/widgets.git",
      default_branch: "main",
    },
    user: { id: 42, login: "octocat", type: "User" },
    body: "nit: rename this",
    reviewId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  selectRows.length = 0;
  resolveWebhookRun.mockResolvedValue(null);
});

describe("resumeFromComment review-comment suppression", () => {
  it("skips a comment that belongs to a Bandolier-posted review", async () => {
    // The suppression lookup finds a run that posted this review.
    selectRows.push([{ jobName: "review-run-1" }]);

    await resumeFromComment(reviewCommentResume(900), CONFIG);

    // Suppressed at the first lookup — never reached the parent lookup or a run.
    expect(dbSelect).toHaveBeenCalledTimes(1);
    expect(resolveWebhookRun).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("proceeds when the review id isn't a Bandolier review", async () => {
    // Suppression lookup finds nothing; the parent lookup also finds nothing, so
    // it stops at "no run to resume" — but only after passing the guard.
    selectRows.push([]); // suppression lookup: no match
    selectRows.push([]); // parent lookup: no parent

    await resumeFromComment(reviewCommentResume(901), CONFIG);

    // Got past suppression to the parent lookup (two selects ran).
    expect(dbSelect).toHaveBeenCalledTimes(2);
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("doesn't run the suppression lookup for a vanilla comment (no review id)", async () => {
    selectRows.push([]); // parent lookup only
    await resumeFromComment(
      { ...reviewCommentResume(null), reviewId: undefined },
      CONFIG,
    );
    // Only the parent lookup ran — no suppression query.
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });
});
