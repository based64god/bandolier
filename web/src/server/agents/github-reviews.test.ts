import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { submitPullRequestReview } from "./github-reviews";

// submitPullRequestReview posts a review via the GitHub reviews API. The one
// behaviour worth pinning is the 422 fallback: inline comments that don't map
// to the PR's diff make GitHub reject the whole review, so it retries body-only
// rather than losing the feedback. fetch is mocked to observe both attempts.

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

function okJson(url: string, id = 55): Response {
  return new Response(JSON.stringify({ id, html_url: url }), { status: 200 });
}

describe("submitPullRequestReview", () => {
  it("posts inline comments and returns the review URL", async () => {
    fetchMock.mockResolvedValueOnce(okJson("https://gh/pull/7#review-1", 55));

    const posted = await submitPullRequestReview("tok", "o/r", 7, {
      event: "COMMENT",
      body: "ok",
      comments: [{ path: "a.ts", line: 3, body: "nit" }],
    });

    expect(posted).toEqual({ id: "55", url: "https://gh/pull/7#review-1" });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    ) as { comments: { path: string; line: number; side: string }[] };
    expect(sent.comments).toEqual([
      { path: "a.ts", line: 3, side: "RIGHT", body: "nit" },
    ]);
  });

  it("retries body-only when the API rejects the inline comments (422)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("bad", { status: 422 }))
      .mockResolvedValueOnce(okJson("https://gh/pull/7#review-2"));

    const posted = await submitPullRequestReview("tok", "o/r", 7, {
      event: "COMMENT",
      body: "summary",
      comments: [{ path: "a.ts", line: 999, body: "off-diff" }],
    });

    expect(posted.url).toBe("https://gh/pull/7#review-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry drops the inline comments.
    const retry = JSON.parse(
      (fetchMock.mock.calls[1]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(retry).not.toHaveProperty("comments");
    expect(retry.body).toBe("summary");
  });
});
