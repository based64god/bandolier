import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGithubItemState,
  postIssueCommentWithFallback,
} from "~/server/agents/github-issues";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getGithubItemState", () => {
  it("returns null for a URL that isn't a GitHub PR/issue link", async () => {
    mockFetchOnce({});
    expect(
      await getGithubItemState("tok", "https://example.com/foo"),
    ).toBeNull();
  });

  it("reports a merged PR as merged even when its state is closed", async () => {
    mockFetchOnce({ state: "closed", merged_at: "2024-01-01T00:00:00Z" });
    expect(
      await getGithubItemState("tok", "https://github.com/o/r/pull/1"),
    ).toBe("merged");
  });

  it("reports a closed-but-unmerged PR as closed", async () => {
    mockFetchOnce({ state: "closed", merged_at: null });
    expect(
      await getGithubItemState("tok", "https://github.com/o/r/pull/2"),
    ).toBe("closed");
  });

  it("reports an open PR as open", async () => {
    mockFetchOnce({ state: "open", merged_at: null });
    expect(
      await getGithubItemState("tok", "https://github.com/o/r/pull/3"),
    ).toBe("open");
  });

  it("reports an issue closed as not planned as closed", async () => {
    mockFetchOnce({ state: "closed", state_reason: "not_planned" });
    expect(
      await getGithubItemState("tok", "https://github.com/o/r/issues/4"),
    ).toBe("closed");
  });

  it("reports an issue completed (e.g. by a PR) as completed", async () => {
    mockFetchOnce({ state: "closed", state_reason: "completed" });
    expect(
      await getGithubItemState("tok", "https://github.com/o/r/issues/7"),
    ).toBe("completed");
  });

  it("reports an open issue as open", async () => {
    mockFetchOnce({ state: "open" });
    expect(
      await getGithubItemState("tok", "https://github.com/o/r/issues/5"),
    ).toBe("open");
  });

  it("returns null on a failed lookup with no cached state", async () => {
    mockFetchOnce({}, false, 500);
    expect(
      await getGithubItemState("tok", "https://github.com/o/r/issues/6"),
    ).toBeNull();
  });
});

describe("postIssueCommentWithFallback", () => {
  /** A fetch mock that fails for the given tokens and succeeds otherwise. */
  function mockFetchByAuth(failTokens: string[]) {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      const failed = failTokens.some((t) => auth === `Bearer ${t}`);
      return Promise.resolve({
        ok: !failed,
        status: failed ? 403 : 201,
        statusText: failed ? "Forbidden" : "Created",
        json: () => Promise.resolve({}),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts with the first candidate token when it succeeds", async () => {
    const fetchMock = mockFetchByAuth([]);
    const via = await postIssueCommentWithFallback(
      [
        { token: "bot", source: "app-installation" },
        { token: "pat", source: "legacy-pat" },
      ],
      "o/r",
      1,
      "hi",
    );
    expect(via).toBe("app-installation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next token when the preferred one fails to post", async () => {
    // The regression: an App installation token that can't comment must not
    // swallow the comment — we fall through to a token that can post.
    const fetchMock = mockFetchByAuth(["bot"]);
    const via = await postIssueCommentWithFallback(
      [
        { token: "bot", source: "app-installation" },
        { token: "pat", source: "legacy-pat" },
        { token: "oauth", source: "user-oauth" },
      ],
      "o/r",
      1,
      "hi",
    );
    expect(via).toBe("legacy-pat");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips empty candidates and de-dupes identical tokens", async () => {
    const fetchMock = mockFetchByAuth(["dup"]);
    const via = await postIssueCommentWithFallback(
      [
        { token: null, source: "app-installation" },
        { token: "dup", source: "legacy-pat" },
        { token: "dup", source: "user-oauth" },
      ],
      "o/r",
      1,
      "hi",
    );
    // Only the one distinct, failing token is tried; nothing posts.
    expect(via).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when every candidate fails", async () => {
    mockFetchByAuth(["bot", "pat"]);
    const via = await postIssueCommentWithFallback(
      [
        { token: "bot", source: "app-installation" },
        { token: "pat", source: "legacy-pat" },
      ],
      "o/r",
      1,
      "hi",
    );
    expect(via).toBeNull();
  });
});
