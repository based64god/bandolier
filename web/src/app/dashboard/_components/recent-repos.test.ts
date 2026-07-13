import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recent-repos persists a most-recent-first repo list in localStorage and
// serves it to React through useSyncExternalStore. The hook only needs a
// synchronous snapshot read, so a shim that (optionally) registers a change
// listener lets everything run outside a React renderer. Tests pin the
// record/dedupe/cap semantics, the parse fallbacks for malformed storage, and
// the snapshot reference stability useSyncExternalStore depends on.
const reactShim = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
}));

vi.mock("react", () => ({
  useSyncExternalStore: (
    subscribe: (cb: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => {
    if (reactShim.listener) subscribe(reactShim.listener);
    return getSnapshot();
  },
}));

const STORAGE_KEY = "bandolier:recent-repos";

/**
 * Stubs a minimal `window` with a Map-backed localStorage (vitest's node env
 * has neither). subscribe() also attaches a cross-tab "storage" listener, so
 * add/removeEventListener must exist.
 */
function stubWindow(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return localStorage;
}

// The module caches the parsed list (and raw string) at module level, and
// keeps a module-level subscriber set — re-import per test for a clean slate.
async function load() {
  return import("~/app/dashboard/_components/recent-repos");
}

beforeEach(() => {
  vi.resetModules();
  reactShim.listener = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recordRecentRepo", () => {
  it("inserts the repo when nothing is stored yet", async () => {
    const storage = stubWindow();
    const { recordRecentRepo } = await load();

    recordRecentRepo("owner/repo");

    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["owner/repo"]));
  });

  it("moves an existing repo to the front without duplicating it", async () => {
    const storage = stubWindow({ [STORAGE_KEY]: JSON.stringify(["x", "y"]) });
    const { recordRecentRepo } = await load();

    recordRecentRepo("y");

    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["y", "x"]));
  });

  it("caps the list at the five most recent repos", async () => {
    const storage = stubWindow({
      [STORAGE_KEY]: JSON.stringify(["a", "b", "c", "d", "e"]),
    });
    const { recordRecentRepo } = await load();

    recordRecentRepo("f");

    expect(storage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify(["f", "a", "b", "c", "d"]),
    );
  });

  it("treats corrupt JSON in storage as an empty list", async () => {
    const storage = stubWindow({ [STORAGE_KEY]: "not json" });
    const { recordRecentRepo } = await load();

    recordRecentRepo("a/b");

    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["a/b"]));
  });

  it("treats non-array JSON in storage as an empty list", async () => {
    const storage = stubWindow({ [STORAGE_KEY]: "{}" });
    const { recordRecentRepo } = await load();

    recordRecentRepo("a/b");

    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["a/b"]));
  });

  it("drops non-string entries from previously stored data", async () => {
    const storage = stubWindow({ [STORAGE_KEY]: '["x",5,null,"y"]' });
    const { recordRecentRepo } = await load();

    recordRecentRepo("z");

    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["z", "x", "y"]));
  });

  it("synchronously notifies subscribers registered through the hook", async () => {
    stubWindow();
    reactShim.listener = vi.fn();
    const { recordRecentRepo, useRecentRepos } = await load();
    useRecentRepos(); // registers the listener via subscribe
    expect(reactShim.listener).not.toHaveBeenCalled();

    recordRecentRepo("a/b");

    // The "storage" event only fires in other tabs; same-tab writes must
    // notify subscribers directly.
    expect(reactShim.listener).toHaveBeenCalledTimes(1);
  });
});

describe("useRecentRepos", () => {
  it("returns the same array reference while storage is unchanged", async () => {
    stubWindow({ [STORAGE_KEY]: JSON.stringify(["a/b", "c/d"]) });
    const { useRecentRepos } = await load();

    const first = useRecentRepos();
    expect(first).toEqual(["a/b", "c/d"]);
    // useSyncExternalStore compares snapshots by reference — re-parsing on
    // every render would make React loop forever.
    expect(useRecentRepos()).toBe(first);
  });

  it("returns a new reference after a write changes the raw string", async () => {
    stubWindow({ [STORAGE_KEY]: JSON.stringify(["a/b"]) });
    const { recordRecentRepo, useRecentRepos } = await load();
    const before = useRecentRepos();

    recordRecentRepo("new/repo");

    const after = useRecentRepos();
    expect(after).not.toBe(before);
    expect(after).toEqual(["new/repo", "a/b"]);
  });

  it("returns a stable shared empty list when nothing is stored", async () => {
    stubWindow();
    const { useRecentRepos } = await load();

    const first = useRecentRepos();
    expect(first).toEqual([]);
    expect(useRecentRepos()).toBe(first);
  });
});
