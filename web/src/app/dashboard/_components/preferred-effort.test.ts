import { afterEach, describe, expect, it, vi } from "vitest";

import { usePreferredEffort } from "~/app/dashboard/_components/preferred-effort";

// usePreferredEffort is a thin useSyncExternalStore wrapper around
// localStorage. Shimming the store hook to a plain synchronous snapshot read
// lets the hook body run outside a React renderer, so the storage semantics
// (empty-string fallback, remove-on-clear, same-tab StorageEvent nudge) can be
// pinned hermetically in the node environment.
vi.mock("react", () => ({
  useSyncExternalStore: (
    _subscribe: (cb: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => getSnapshot(),
}));

const PREF_KEY = "bandolier:preferred-effort";

/** Map-backed localStorage stand-in; vitest's node env has no localStorage. */
function stubLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

/** Stubs window.dispatchEvent plus the StorageEvent ctor (absent in node). */
function stubWindowEvents() {
  const dispatchEvent = vi.fn<(event: unknown) => void>();
  vi.stubGlobal("window", { dispatchEvent });
  class FakeStorageEvent {
    constructor(public type: string) {}
  }
  vi.stubGlobal("StorageEvent", FakeStorageEvent);
  return { dispatchEvent, FakeStorageEvent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePreferredEffort", () => {
  it("returns '' when no preference is stored", () => {
    stubLocalStorage();
    expect(usePreferredEffort()[0]).toBe("");
  });

  it("returns the stored effort level", () => {
    stubLocalStorage({ [PREF_KEY]: "high" });
    expect(usePreferredEffort()[0]).toBe("high");
  });

  it("set stores the value and nudges this tab with a storage event", () => {
    const storage = stubLocalStorage();
    const { dispatchEvent, FakeStorageEvent } = stubWindowEvents();
    const [, set] = usePreferredEffort();

    set("high");

    expect(storage.getItem(PREF_KEY)).toBe("high");
    // The native "storage" event only fires in other tabs, so set() must
    // dispatch one locally for same-tab subscribers.
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(FakeStorageEvent);
    expect((event as InstanceType<typeof FakeStorageEvent>).type).toBe(
      "storage",
    );
  });

  it("set('') removes the key instead of persisting an empty string", () => {
    const storage = stubLocalStorage({ [PREF_KEY]: "high" });
    const { dispatchEvent } = stubWindowEvents();
    const [, set] = usePreferredEffort();

    set("");

    // null (key removed) rather than "" (empty string stored).
    expect(storage.getItem(PREF_KEY)).toBeNull();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
