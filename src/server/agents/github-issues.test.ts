import { afterEach, describe, expect, it, vi } from "vitest";

import { getGithubItemState } from "~/server/agents/github-issues";

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
      await getGithubItemState(
        "tok",
        "https://github.com/o/r/pull/1",
      ),
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
