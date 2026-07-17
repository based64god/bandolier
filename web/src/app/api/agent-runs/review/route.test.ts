import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestToken } from "~/lib/ingest";

// The review-submit endpoint posts a run's PR review in the bot voice. Mock its
// boundaries — the run-row lookup, the bot-token broker, and the reviews-API
// submit — so the auth gate, PR scoping, bot-voice attribution, and output
// recording can be driven hermetically.

const SECRET = "test-secret"; // matches vitest.config.ts BETTER_AUTH_SECRET

const getRepoBotToken = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/github-app", () => ({
  getRepoBotToken: () => getRepoBotToken(),
}));

const getUserGithubToken = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/github-token", () => ({
  getUserGithubToken: () => getUserGithubToken(),
}));

const submitPullRequestReview =
  vi.fn<
    (
      token: string,
      repo: string,
      pr: number,
      review: unknown,
    ) => Promise<{ id: string; url: string }>
  >();
vi.mock("~/server/agents/github-reviews", () => ({
  submitPullRequestReview: (
    token: string,
    repo: string,
    pr: number,
    review: unknown,
  ) => submitPullRequestReview(token, repo, pr, review),
}));

const selectRows: unknown[][] = [];
const updateSets: unknown[] = [];
vi.mock("~/server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectRows.shift() ?? []),
        }),
      }),
    }),
    update: () => ({
      set: (payload: unknown) => {
        updateSets.push(payload);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  },
}));

const { POST } = await import("~/app/api/agent-runs/review/route");

function authHeaders(jobName: string): Record<string, string> {
  return {
    "x-bandolier-job": jobName,
    authorization: `Bearer ${ingestToken(jobName, SECRET)}`,
    "content-type": "application/json",
  };
}

function post(headers: Record<string, string>, body: unknown): Request {
  return new Request("http://localhost/api/agent-runs/review", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const REVIEW = {
  event: "COMMENT",
  body: "Looks mostly good.",
  comments: [{ path: "src/a.ts", line: 12, body: "nit: rename" }],
};

beforeEach(() => {
  selectRows.length = 0;
  updateSets.length = 0;
  getRepoBotToken.mockReset().mockResolvedValue("bot-token");
  getUserGithubToken.mockReset().mockResolvedValue("user-token");
  submitPullRequestReview.mockReset().mockResolvedValue({
    id: "999",
    url: "https://github.com/o/r/pull/7#pullrequestreview-1",
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/agent-runs/review", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await POST(
      post({ "content-type": "application/json" }, REVIEW) as never,
    );
    expect(res.status).toBe(401);
    expect(submitPullRequestReview).not.toHaveBeenCalled();
  });

  it("posts a webhook review with the bot token and records URL + review id", async () => {
    selectRows.push([
      {
        repoFullName: "o/r",
        reviewedPrUrl: "https://github.com/o/r/pull/7",
        reviewAsUser: false,
        spawnedBy: "u1",
      },
    ]);

    const res = await POST(post(authHeaders("job-1"), REVIEW) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://github.com/o/r/pull/7#pullrequestreview-1",
    });
    // Bot voice: posted with the installation token, to the PR on the run row.
    expect(submitPullRequestReview).toHaveBeenCalledWith(
      "bot-token",
      "o/r",
      7,
      expect.objectContaining({ event: "COMMENT", body: "Looks mostly good." }),
    );
    expect(getUserGithubToken).not.toHaveBeenCalled();
    // The review URL and its id are recorded on the run.
    expect(updateSets[0]).toMatchObject({
      pullRequestUrl: "https://github.com/o/r/pull/7#pullrequestreview-1",
      postedReviewId: "999",
    });
  });

  it("posts a dashboard review in the owner's voice (their GitHub token)", async () => {
    selectRows.push([
      {
        repoFullName: "o/r",
        reviewedPrUrl: "https://github.com/o/r/pull/7",
        reviewAsUser: true,
        spawnedBy: "u1",
      },
    ]);

    const res = await POST(post(authHeaders("job-1"), REVIEW) as never);

    expect(res.status).toBe(200);
    // User voice: posted with the owner's token, never the bot token.
    expect(submitPullRequestReview).toHaveBeenCalledWith(
      "user-token",
      "o/r",
      7,
      expect.anything(),
    );
    expect(getRepoBotToken).not.toHaveBeenCalled();
  });

  it("503s a dashboard review whose owner has no GitHub token", async () => {
    selectRows.push([
      {
        repoFullName: "o/r",
        reviewedPrUrl: "https://github.com/o/r/pull/7",
        reviewAsUser: true,
        spawnedBy: "u1",
      },
    ]);
    getUserGithubToken.mockResolvedValue(null);
    const res = await POST(post(authHeaders("job-1"), REVIEW) as never);
    expect(res.status).toBe(503);
    expect(submitPullRequestReview).not.toHaveBeenCalled();
  });

  it("404s when the run isn't a review run", async () => {
    selectRows.push([{ repoFullName: "o/r", reviewedPrUrl: null }]);
    const res = await POST(post(authHeaders("job-1"), REVIEW) as never);
    expect(res.status).toBe(404);
    expect(submitPullRequestReview).not.toHaveBeenCalled();
  });

  it("503s when the repo has no bot identity (never falls back to user creds)", async () => {
    selectRows.push([
      { repoFullName: "o/r", reviewedPrUrl: "https://github.com/o/r/pull/7" },
    ]);
    getRepoBotToken.mockResolvedValue(null);
    const res = await POST(post(authHeaders("job-1"), REVIEW) as never);
    expect(res.status).toBe(503);
    expect(submitPullRequestReview).not.toHaveBeenCalled();
  });

  it("400s an empty review (no body, no comments)", async () => {
    selectRows.push([
      { repoFullName: "o/r", reviewedPrUrl: "https://github.com/o/r/pull/7" },
    ]);
    const res = await POST(
      post(authHeaders("job-1"), { event: "COMMENT", body: "  ", comments: [] }) as never,
    );
    expect(res.status).toBe(400);
  });
});
