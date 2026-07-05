import { afterEach, describe, expect, it, vi } from "vitest";

import { getRepoAccess, ghFetch, ghHeaders, TtlMap } from "./github-api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ghHeaders", () => {
  it("carries the auth, media-type, and API-version triple", () => {
    expect(ghHeaders("tok")).toEqual({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });
});

describe("ghFetch", () => {
  function stubFetch(res: Partial<Response>) {
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends the standard headers and returns the response on 2xx", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, statusText: "OK" });
    const res = await ghFetch("https://api.github.com/x", "tok");
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/x");
    expect(init.headers).toEqual(ghHeaders("tok"));
  });

  it("merges per-call headers over the defaults", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, statusText: "OK" });
    await ghFetch("https://api.github.com/x", "tok", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "custom" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer tok",
      Accept: "custom",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    });
  });

  it("throws GitHub API <status>: <statusText> on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 403, statusText: "Forbidden" });
    await expect(ghFetch("https://api.github.com/x", "tok")).rejects.toThrow(
      "GitHub API 403: Forbidden",
    );
  });

  it("lets transport errors propagate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(ghFetch("https://api.github.com/x", "tok")).rejects.toThrow(
      "network",
    );
  });
});

describe("getRepoAccess", () => {
  function stubFetch(res: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reports accessible + admin from a single repo probe", async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ permissions: { admin: true } }),
    });
    expect(await getRepoAccess("tok", "o/r")).toEqual({
      accessible: true,
      isAdmin: true,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/o/r",
    );
  });

  it("is accessible but not admin when admin isn't boolean true", async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ permissions: { admin: 1 } }),
    });
    expect(await getRepoAccess("tok", "o/r")).toEqual({
      accessible: true,
      isAdmin: false,
    });
  });

  it("fails closed on a non-2xx without reading the body", async () => {
    const json = vi.fn();
    stubFetch({ ok: false, status: 404, statusText: "Not Found", json });
    expect(await getRepoAccess("tok", "o/r")).toEqual({
      accessible: false,
      isAdmin: false,
    });
    expect(json).not.toHaveBeenCalled();
  });

  it("fails closed when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await getRepoAccess("tok", "o/r")).toEqual({
      accessible: false,
      isAdmin: false,
    });
  });
});

describe("TtlMap", () => {
  it("returns a value only while it is fresh", () => {
    const m = new TtlMap<string, number>(10);
    m.set("a", 1, 0, 100);
    expect(m.get("a", 50)).toBe(1);
    expect(m.get("a", 100)).toBeUndefined();
    expect(m.get("a", 150)).toBeUndefined();
  });

  it("distinguishes a stored null value from an absent key", () => {
    const m = new TtlMap<string, number | null>(10);
    m.set("a", null, 0, 100);
    expect(m.get("a", 50)).toBeNull();
    expect(m.get("missing", 50)).toBeUndefined();
  });

  it("treats a default (Infinity) expiry as terminal", () => {
    const m = new TtlMap<string, string>(10);
    m.set("a", "merged", 0);
    expect(m.get("a", 1e15)).toBe("merged");
  });

  it("peek returns the entry regardless of freshness", () => {
    const m = new TtlMap<string, number>(10);
    m.set("a", 7, 0, 100);
    expect(m.peek("a")?.value).toBe(7);
    // Still peekable after expiry — used for stale fallback reads.
    m.get("a", 200);
    expect(m.peek("a")?.value).toBe(7);
  });

  it("sweeps expired entries on write", () => {
    const m = new TtlMap<string, number>(10);
    m.set("stale", 1, 0, 100);
    m.set("fresh", 2, 200, 300);
    expect(m.peek("stale")).toBeUndefined();
    expect(m.peek("fresh")?.value).toBe(2);
  });

  it("evicts the oldest surviving entry when over capacity", () => {
    const m = new TtlMap<string, number>(2);
    m.set("a", 1, 0, 1_000);
    m.set("b", 2, 0, 1_000);
    m.set("c", 3, 0, 1_000);
    expect(m.get("a", 0)).toBeUndefined();
    expect(m.get("b", 0)).toBe(2);
    expect(m.get("c", 0)).toBe(3);
  });

  it("counts a refreshed key as newest for eviction order", () => {
    const m = new TtlMap<string, number>(2);
    m.set("a", 1, 0, 1_000);
    m.set("b", 2, 0, 1_000);
    m.set("a", 10, 0, 1_000); // refresh a → b is now oldest
    m.set("c", 3, 0, 1_000);
    expect(m.get("b", 0)).toBeUndefined();
    expect(m.get("a", 0)).toBe(10);
    expect(m.get("c", 0)).toBe(3);
  });

  it("delete removes an entry", () => {
    const m = new TtlMap<string, number>(10);
    m.set("a", 1, 0, 1_000);
    m.delete("a");
    expect(m.get("a", 0)).toBeUndefined();
  });
});
