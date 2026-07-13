import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getGithubItemState,
  getIssue,
  getPullRequestRefs,
  listCommentReactions,
  listOpenIssues,
  postIssueComment,
  postIssueCommentReturningId,
  postIssueCommentWithFallback,
  resolveItemStates,
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

// The state cache is module-level, keyed by URL, and has no reset hook, so
// every test here uses a distinct issue/PR URL to stay isolated (including
// from the getGithubItemState tests above).
describe("getGithubItemState caching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function okState(body: unknown) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
    };
  }

  it("serves the cached state within the 60s TTL without refetching", async () => {
    const url = "https://github.com/o/r/issues/101";
    const fetchMock = vi.fn().mockResolvedValue(okState({ state: "open" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGithubItemState("tok", url)).toBe("open");
    vi.advanceTimersByTime(10_000);
    expect(await getGithubItemState("tok", url)).toBe("open");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last known state when a stale refresh gets an error response", async () => {
    const url = "https://github.com/o/r/issues/102";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okState({ state: "open" }))
      .mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Error",
        json: () => Promise.resolve({}),
      });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGithubItemState("tok", url)).toBe("open");
    vi.advanceTimersByTime(61_000);
    // The refresh attempt fails; the stale-but-known state wins over null.
    expect(await getGithubItemState("tok", url)).toBe("open");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known state when a stale refresh throws", async () => {
    const url = "https://github.com/o/r/issues/103";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okState({ state: "open" }))
      .mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGithubItemState("tok", url)).toBe("open");
    vi.advanceTimersByTime(61_000);
    expect(await getGithubItemState("tok", url)).toBe("open");
  });

  it("treats merged as terminal — never refetched even after the TTL", async () => {
    const url = "https://github.com/o/r/pull/104";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okState({ state: "closed", merged_at: "2024-01-01T00:00:00Z" }),
      )
      // Would report open again if the cache ever expired.
      .mockResolvedValue(okState({ state: "open", merged_at: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGithubItemState("tok", url)).toBe("merged");
    vi.advanceTimersByTime(61_000);
    expect(await getGithubItemState("tok", url)).toBe("merged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("listOpenIssues", () => {
  it("filters out pull requests and defaults a missing body to empty", async () => {
    mockFetchOnce([
      {
        number: 1,
        title: "bug",
        html_url: "https://github.com/o/r/issues/1",
        body: null,
      },
      {
        number: 2,
        title: "pr",
        html_url: "https://github.com/o/r/pull/2",
        body: "x",
        pull_request: {},
      },
    ]);
    expect(await listOpenIssues("tok", "o/r")).toEqual([
      {
        number: 1,
        title: "bug",
        url: "https://github.com/o/r/issues/1",
        body: "",
      },
    ]);
  });

  it("requests open issues sorted by update with the repo token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal("fetch", fetchMock);
    await listOpenIssues("tok", "o/r");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(
      "https://api.github.com/repos/o/r/issues",
    );
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("sort")).toBe("updated");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });

  it("throws with the GitHub status on an error response", async () => {
    mockFetchOnce({}, false, 500);
    await expect(listOpenIssues("tok", "o/r")).rejects.toThrow(
      "GitHub API 500: Error",
    );
  });
});

describe("getIssue", () => {
  it("maps the raw issue, renaming html_url and defaulting the body", async () => {
    mockFetchOnce({
      number: 7,
      title: "t",
      html_url: "https://github.com/o/r/issues/7",
      body: null,
    });
    expect(await getIssue("tok", "o/r", 7)).toEqual({
      number: 7,
      title: "t",
      url: "https://github.com/o/r/issues/7",
      body: "",
    });
  });

  it("returns null for a 404 (issue not found)", async () => {
    mockFetchOnce({}, false, 404);
    expect(await getIssue("tok", "o/r", 999)).toBeNull();
  });

  it("throws on other error statuses", async () => {
    mockFetchOnce({}, false, 500);
    await expect(getIssue("tok", "o/r", 7)).rejects.toThrow(
      "GitHub API 500: Error",
    );
  });
});

describe("getPullRequestRefs", () => {
  it("maps head/base refs, the head repo, and merged from merged_at", async () => {
    mockFetchOnce({
      state: "closed",
      merged_at: "2024-01-01T00:00:00Z",
      head: { ref: "feat", repo: { full_name: "o/r" } },
      base: { ref: "main" },
    });
    expect(await getPullRequestRefs("tok", "o/r", 5)).toEqual({
      headRef: "feat",
      baseRef: "main",
      headRepoFullName: "o/r",
      state: "closed",
      merged: true,
    });
  });

  it("handles a deleted fork head repo and an unmerged PR", async () => {
    mockFetchOnce({
      state: "open",
      merged_at: null,
      head: { ref: "feat", repo: null },
      base: { ref: "main" },
    });
    expect(await getPullRequestRefs("tok", "o/r", 6)).toEqual({
      headRef: "feat",
      baseRef: "main",
      headRepoFullName: null,
      state: "open",
      merged: false,
    });
  });

  it("returns null on an error response and on a network failure", async () => {
    mockFetchOnce({}, false, 500);
    expect(await getPullRequestRefs("tok", "o/r", 7)).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await getPullRequestRefs("tok", "o/r", 7)).toBeNull();
  });
});

describe("postIssueComment", () => {
  it("POSTs the comment body as JSON to the issue's comments endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: "Created",
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await postIssueComment("tok", "o/r", 1, "hello");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/issues/1/comments");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(init.body).toBe(JSON.stringify({ body: "hello" }));
  });
});

describe("postIssueCommentReturningId", () => {
  it("returns the created comment's id", async () => {
    mockFetchOnce({ id: 987 });
    expect(await postIssueCommentReturningId("tok", "o/r", 1, "approve?")).toBe(
      987,
    );
  });

  it("throws on an error response", async () => {
    mockFetchOnce({}, false, 403);
    await expect(
      postIssueCommentReturningId("tok", "o/r", 1, "x"),
    ).rejects.toThrow("GitHub API 403: Error");
  });
});

describe("listCommentReactions", () => {
  it("lists reactions using the reactions preview media type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve([{ content: "+1", user: { login: "alice" } }]),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await listCommentReactions("tok", "o/r", 55)).toEqual([
      { content: "+1", user: { login: "alice" } },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/o/r/issues/comments/55/reactions",
    );
    expect((init.headers as Record<string, string>).Accept).toBe(
      "application/vnd.github.squirrel-girl-preview+json",
    );
  });

  it("throws on an error response", async () => {
    mockFetchOnce({}, false, 500);
    await expect(listCommentReactions("tok", "o/r", 55)).rejects.toThrow(
      "GitHub API 500: Error",
    );
  });
});

// resolveItemStates delegates to the in-module getGithubItemState, which is not
// separately mockable, so these drive real behavior through the fetch mock.
// getGithubItemState caches by the html url with no reset hook, so each test
// here uses distinct issue/PR numbers to stay isolated from the suites above.
describe("resolveItemStates", () => {
  it("returns all-null states and never calls the API without a token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await resolveItemStates(null, {
        pullRequestUrl: "https://github.com/o/r/pull/301",
        createdIssueUrl: "https://github.com/o/r/issues/302",
        issueUrl: "https://github.com/o/r/issues/303",
      }),
    ).toEqual({
      pullRequestState: null,
      createdIssueState: null,
      issueState: null,
    });
    // Without a token the function short-circuits before any lookup.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves each url's state in parallel when a token is present", async () => {
    // Route by the resolved GitHub API path so every ref gets a distinct state,
    // proving each url maps to its own result field rather than to a shared one.
    const fetchMock = vi.fn((url: string) => {
      let body: unknown;
      if (url.endsWith("/pulls/304")) {
        body = { state: "closed", merged_at: "2024-01-01T00:00:00Z" };
      } else if (url.endsWith("/issues/305")) {
        body = { state: "closed", state_reason: "completed" };
      } else {
        body = { state: "open" };
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await resolveItemStates("tok", {
        pullRequestUrl: "https://github.com/o/r/pull/304",
        createdIssueUrl: "https://github.com/o/r/issues/305",
        issueUrl: "https://github.com/o/r/issues/306",
      }),
    ).toEqual({
      pullRequestState: "merged",
      createdIssueState: "completed",
      issueState: "open",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips the lookup for null urls and leaves their state null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ state: "open" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await resolveItemStates("tok", {
        pullRequestUrl: null,
        createdIssueUrl: null,
        issueUrl: "https://github.com/o/r/issues/307",
      }),
    ).toEqual({
      pullRequestState: null,
      createdIssueState: null,
      issueState: "open",
    });
    // Only the single non-null url triggers a fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
