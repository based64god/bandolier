import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getTokenRepoRole,
  getUserRepoRole,
  isApprovalReaction,
  isMaintainerRole,
  listIssueCommentReactions,
  tokenHasMaintainerAccess,
  userHasMaintainerAccess,
} from "~/server/agents/github-permissions";

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

describe("isMaintainerRole", () => {
  it("treats maintain and admin as maintainer", () => {
    expect(isMaintainerRole("maintain")).toBe(true);
    expect(isMaintainerRole("admin")).toBe(true);
  });
  it("rejects write and below", () => {
    expect(isMaintainerRole("write")).toBe(false);
    expect(isMaintainerRole("triage")).toBe(false);
    expect(isMaintainerRole("read")).toBe(false);
    expect(isMaintainerRole("none")).toBe(false);
  });
});

describe("getTokenRepoRole", () => {
  it("maps the highest permission flag to a role", async () => {
    mockFetchOnce({
      permissions: { admin: false, maintain: true, push: true },
    });
    expect(await getTokenRepoRole("tok", "o/r")).toBe("maintain");
  });

  it("returns write when only push is set", async () => {
    mockFetchOnce({ permissions: { push: true } });
    expect(await getTokenRepoRole("tok", "o/r")).toBe("write");
  });

  it("returns none when there is no permissions block", async () => {
    mockFetchOnce({});
    expect(await getTokenRepoRole("tok", "o/r")).toBe("none");
  });

  it("returns none (fails closed) on an API error", async () => {
    mockFetchOnce({}, false, 403);
    expect(await getTokenRepoRole("tok", "o/r")).toBe("none");
  });
});

describe("tokenHasMaintainerAccess", () => {
  it("is true for an admin", async () => {
    mockFetchOnce({ permissions: { admin: true } });
    expect(await tokenHasMaintainerAccess("tok", "o/r")).toBe(true);
  });
  it("is false for a plain pusher", async () => {
    mockFetchOnce({ permissions: { push: true } });
    expect(await tokenHasMaintainerAccess("tok", "o/r")).toBe(false);
  });
});

describe("getUserRepoRole", () => {
  it("prefers the granular role_name", async () => {
    mockFetchOnce({ role_name: "maintain", permission: "write" });
    expect(await getUserRepoRole("tok", "o/r", "alice")).toBe("maintain");
  });

  it("falls back to the coarse permission field", async () => {
    mockFetchOnce({ permission: "admin" });
    expect(await getUserRepoRole("tok", "o/r", "alice")).toBe("admin");
  });

  it("returns none on an API error", async () => {
    mockFetchOnce({}, false, 404);
    expect(await getUserRepoRole("tok", "o/r", "alice")).toBe("none");
  });
});

describe("userHasMaintainerAccess", () => {
  it("is true when role_name is maintain", async () => {
    mockFetchOnce({ role_name: "maintain" });
    expect(await userHasMaintainerAccess("tok", "o/r", "alice")).toBe(true);
  });
  it("is false when role_name is write", async () => {
    mockFetchOnce({ role_name: "write" });
    expect(await userHasMaintainerAccess("tok", "o/r", "alice")).toBe(false);
  });
});

describe("isApprovalReaction", () => {
  it("accepts the affirmative reactions", () => {
    for (const c of ["+1", "heart", "hooray", "rocket"]) {
      expect(isApprovalReaction(c)).toBe(true);
    }
  });
  it("rejects -1 and other reactions", () => {
    expect(isApprovalReaction("-1")).toBe(false);
    expect(isApprovalReaction("eyes")).toBe(false);
    expect(isApprovalReaction("confused")).toBe(false);
  });
});

describe("listIssueCommentReactions", () => {
  it("maps reactions and drops ones without a user", async () => {
    mockFetchOnce([
      { content: "+1", user: { login: "alice" } },
      { content: "rocket", user: null },
    ]);
    const reactions = await listIssueCommentReactions("tok", "o/r", 99);
    expect(reactions).toEqual([{ content: "+1", userLogin: "alice" }]);
  });

  it("returns [] on an API error", async () => {
    mockFetchOnce({}, false, 500);
    expect(await listIssueCommentReactions("tok", "o/r", 99)).toEqual([]);
  });
});
