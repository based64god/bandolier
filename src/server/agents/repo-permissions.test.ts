import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getUserRepoPermission,
  isMaintainerOrHigher,
  type RepoPermission,
} from "~/server/agents/repo-permissions";

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

describe("isMaintainerOrHigher", () => {
  const table: [RepoPermission, boolean][] = [
    ["none", false],
    ["read", false],
    ["triage", false],
    ["write", false],
    ["maintain", true],
    ["admin", true],
  ];
  it.each(table)("%s → %s", (perm, expected) => {
    expect(isMaintainerOrHigher(perm)).toBe(expected);
  });
});

describe("getUserRepoPermission", () => {
  it("returns the coarse permission when no finer role is given", async () => {
    mockFetchOnce({ permission: "admin" });
    expect(await getUserRepoPermission("tok", "o/r", "alice")).toBe("admin");
  });

  it("prefers the finer role_name when it is more privileged", async () => {
    // GitHub collapses a "maintain" role into the coarse "write" bucket; the
    // finer role_name must win so the maintainer isn't under-counted.
    mockFetchOnce({ permission: "write", role_name: "maintain" });
    expect(await getUserRepoPermission("tok", "o/r", "bob")).toBe("maintain");
  });

  it("keeps the coarse permission when role_name is less privileged", async () => {
    mockFetchOnce({ permission: "admin", role_name: "write" });
    expect(await getUserRepoPermission("tok", "o/r", "carol")).toBe("admin");
  });

  it("maps an unknown permission string to none", async () => {
    mockFetchOnce({ permission: "something-custom" });
    expect(await getUserRepoPermission("tok", "o/r", "dave")).toBe("none");
  });

  it("fails closed (none) on an API error", async () => {
    mockFetchOnce({}, false, 404);
    expect(await getUserRepoPermission("tok", "o/r", "eve")).toBe("none");
  });

  it("fails closed (none) when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(await getUserRepoPermission("tok", "o/r", "frank")).toBe("none");
  });
});
