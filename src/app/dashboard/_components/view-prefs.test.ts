import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cookie-backed view-preference hooks only call useSyncExternalStore, so a
// shim that (optionally) registers a change listener and returns the snapshot
// synchronously lets them run outside a React renderer. Tests pin the cookie
// token parsing, the exact write formats, and the direct subscriber
// notification that stands in for the change event cookies don't have.
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

/** Stubs `document` with a recording cookie property; returns the writes. */
function stubDocumentCookie(value = "") {
  const writes: string[] = [];
  vi.stubGlobal("document", {
    get cookie() {
      return value;
    },
    set cookie(next: string) {
      writes.push(next);
    },
  });
  return writes;
}

// Each hook closes over a module-level subscriber set, so re-import per test
// to keep one test's subscribers from leaking into the next.
async function loadHooks() {
  return import("~/app/dashboard/_components/view-prefs");
}

beforeEach(() => {
  vi.resetModules();
  reactShim.listener = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useHideResolved", () => {
  it("reads true when the cookie token is present among others", async () => {
    stubDocumentCookie("foo=bar; bandolier:hide-resolved=1");
    const { useHideResolved } = await loadHooks();
    expect(useHideResolved()[0]).toBe(true);
  });

  it("reads false when the cookie is absent", async () => {
    stubDocumentCookie("foo=bar");
    const { useHideResolved } = await loadHooks();
    expect(useHideResolved()[0]).toBe(false);
  });

  it("reads false when the cookie holds 0 rather than 1", async () => {
    stubDocumentCookie("bandolier:hide-resolved=0");
    const { useHideResolved } = await loadHooks();
    expect(useHideResolved()[0]).toBe(false);
  });

  it("ignores a superstring cookie name (exact token match, not substring)", async () => {
    stubDocumentCookie("xbandolier:hide-resolved=1");
    const { useHideResolved } = await loadHooks();
    expect(useHideResolved()[0]).toBe(false);
  });

  it("reads false when document is undefined (SSR guard)", async () => {
    // No document stub — vitest's node environment has no document global.
    const { useHideResolved } = await loadHooks();
    expect(useHideResolved()[0]).toBe(false);
  });

  it("set(true) writes a year-long lax cookie scoped to /", async () => {
    const writes = stubDocumentCookie();
    const { useHideResolved } = await loadHooks();
    const [, set] = useHideResolved();

    set(true);

    expect(writes).toEqual([
      "bandolier:hide-resolved=1; path=/; max-age=31536000; samesite=lax",
    ]);
  });

  it("set(false) expires the cookie immediately", async () => {
    const writes = stubDocumentCookie("bandolier:hide-resolved=1");
    const { useHideResolved } = await loadHooks();
    const [, set] = useHideResolved();

    set(false);

    expect(writes).toEqual([
      "bandolier:hide-resolved=; path=/; max-age=0; samesite=lax",
    ]);
  });

  it("set notifies subscribers directly (cookies emit no change event)", async () => {
    stubDocumentCookie();
    reactShim.listener = vi.fn();
    const { useHideResolved } = await loadHooks();
    const [, set] = useHideResolved();
    expect(reactShim.listener).not.toHaveBeenCalled();

    set(true);

    expect(reactShim.listener).toHaveBeenCalledTimes(1);
  });
});

describe("useOnlyMine", () => {
  it("uses its own cookie key, independent of hide-resolved", async () => {
    stubDocumentCookie("bandolier:hide-resolved=1");
    const { useHideResolved, useOnlyMine } = await loadHooks();
    expect(useOnlyMine()[0]).toBe(false);
    expect(useHideResolved()[0]).toBe(true);
  });

  it("reads and writes the bandolier:only-mine cookie", async () => {
    const writes = stubDocumentCookie("bandolier:only-mine=1");
    const { useOnlyMine } = await loadHooks();
    const [enabled, set] = useOnlyMine();
    expect(enabled).toBe(true);

    set(true);

    expect(writes).toEqual([
      "bandolier:only-mine=1; path=/; max-age=31536000; samesite=lax",
    ]);
  });
});
