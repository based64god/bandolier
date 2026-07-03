import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// notifications.ts drives completion/awaiting-input alerts from three hooks
// plus a few plain helpers. The hooks only use useSyncExternalStore, useRef,
// and useEffect, so a tiny fake React runtime — refs keyed by call order that
// persist across sequential invocations, effects that run immediately — lets
// the transition-detection logic run without a renderer. Browser APIs
// (Notification, AudioContext, window, localStorage, StorageEvent) are all
// stubbed; nothing leaves the process.
const fakeReact = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock("react", () => ({
  useSyncExternalStore: (
    _subscribe: (cb: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => getSnapshot(),
  useRef: (initial: unknown) =>
    (fakeReact.refs[fakeReact.refIndex++] ??= { current: initial }),
  useEffect: (effect: () => unknown) => void effect(),
}));

/** Runs one "render": resets the ref cursor, then invokes the hook body. */
function render<T>(hook: () => T): T {
  fakeReact.refIndex = 0;
  return hook();
}

type FakeOscillator = {
  type: string;
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

/**
 * Web-Audio stub rich enough for playChime. Exposes the constructed contexts
 * (the module lazily caches exactly one) and every oscillator, so tests can
 * assert both the singleton behavior and the chime's shape.
 */
function stubAudioContext(state = "suspended") {
  const oscillators: FakeOscillator[] = [];
  class FakeAudioContext {
    state = state;
    currentTime = 0;
    destination = {};
    resume = vi.fn(() => Promise.resolve());
    createOscillator = vi.fn(() => {
      const osc: FakeOscillator = {
        type: "",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    });
    createGain = vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }));
    constructor() {
      contexts.push(this);
    }
  }
  const contexts: FakeAudioContext[] = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return { contexts, oscillators };
}

/** Notification stub: static permission plus a spy on construction. */
function stubNotification(permission: "default" | "granted" | "denied") {
  const constructed =
    vi.fn<(title: string, options: NotificationOptions) => void>();
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(() => Promise.resolve("granted"));
    constructor(title: string, options: NotificationOptions) {
      constructed(title, options);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  return { constructed, requestPermission: FakeNotification.requestPermission };
}

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

/**
 * Environment for the alert hooks: granted notification permission, a bare
 * `navigator` without serviceWorker (forcing showNativeNotification down the
 * synchronous constructor path), a window whose matchMedia reports standalone
 * (or not), and a suspended AudioContext.
 */
function stubAlertEnv({ standalone = false } = {}) {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({ matches: standalone })),
    navigator: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return { ...stubNotification("granted"), ...stubAudioContext() };
}

// The module caches its AudioContext at module level; re-import per test so
// the cache — and the fake refs backing the hooks — start fresh.
async function load() {
  return import("~/app/dashboard/_components/notifications");
}

beforeEach(() => {
  vi.resetModules();
  fakeReact.refs = [];
  fakeReact.refIndex = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isStandalone", () => {
  it("is false when window is undefined (SSR)", async () => {
    // No window stub — vitest's node environment has no window global.
    const { isStandalone } = await load();
    expect(isStandalone()).toBe(false);
  });

  it("is true when the display-mode media query matches", async () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("window", { matchMedia, navigator: {} });
    const { isStandalone } = await load();
    expect(isStandalone()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(display-mode: standalone)");
  });

  it("falls back to iOS Safari's navigator.standalone flag", async () => {
    // No matchMedia at all — the optional call short-circuits to the flag.
    vi.stubGlobal("window", { navigator: { standalone: true } });
    const { isStandalone } = await load();
    expect(isStandalone()).toBe(true);
  });

  it("is false in a plain browser tab", async () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
      navigator: {},
    });
    const { isStandalone } = await load();
    expect(isStandalone()).toBe(false);
  });
});

describe("requestNotificationPermission", () => {
  it("no-ops when the Notification API is unavailable", async () => {
    // No Notification stub — node has no Notification global.
    const { requestNotificationPermission } = await load();
    await expect(requestNotificationPermission()).resolves.toBeUndefined();
  });

  it("requests permission when it hasn't been decided yet", async () => {
    const { requestPermission } = stubNotification("default");
    const { requestNotificationPermission } = await load();
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it.each(["granted", "denied"] as const)(
    "does not re-prompt when permission is already %s",
    async (permission) => {
      const { requestPermission } = stubNotification(permission);
      const { requestNotificationPermission } = await load();
      await requestNotificationPermission();
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );
});

describe("primeAudio", () => {
  it("no-ops when the Web Audio API is unavailable", async () => {
    // No AudioContext stub — node has no AudioContext global.
    const { primeAudio } = await load();
    expect(() => primeAudio()).not.toThrow();
  });

  it("lazily constructs a single AudioContext and resumes it on every call", async () => {
    const { contexts } = stubAudioContext();
    const { primeAudio } = await load();
    expect(contexts).toHaveLength(0); // nothing until the first call

    primeAudio();
    primeAudio();

    expect(contexts).toHaveLength(1); // module-level singleton
    expect(contexts[0]?.resume).toHaveBeenCalledTimes(2);
  });
});

describe("useNotifyPref", () => {
  it("reads true only when the stored flag is the string '1'", async () => {
    const storage = stubLocalStorage();
    const { useNotifyPref } = await load();

    expect(useNotifyPref()[0]).toBe(false); // key missing
    storage.setItem("bandolier:notify", "0");
    expect(useNotifyPref()[0]).toBe(false);
    storage.setItem("bandolier:notify", "1");
    expect(useNotifyPref()[0]).toBe(true);
  });

  it("set writes '1'/'0' and nudges this tab with a storage event", async () => {
    const storage = stubLocalStorage();
    const dispatchEvent = vi.fn<(event: unknown) => void>();
    vi.stubGlobal("window", { dispatchEvent });
    class FakeStorageEvent {
      constructor(public type: string) {}
    }
    vi.stubGlobal("StorageEvent", FakeStorageEvent);
    const { useNotifyPref } = await load();
    const [, set] = useNotifyPref();

    set(true);
    expect(storage.getItem("bandolier:notify")).toBe("1");
    set(false);
    expect(storage.getItem("bandolier:notify")).toBe("0");

    // The native "storage" event only fires in other tabs, so each write must
    // dispatch one locally for same-tab subscribers.
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls[0]?.[0]).toBeInstanceOf(FakeStorageEvent);
  });
});

describe("useChimeUnlock", () => {
  it("arms one-shot unlock listeners while audio is suspended", async () => {
    const addEventListener = vi.fn<(type: string, cb: () => void) => void>();
    const removeEventListener = vi.fn<(type: string, cb: () => void) => void>();
    vi.stubGlobal("window", { addEventListener, removeEventListener });
    const { contexts } = stubAudioContext("suspended");
    const { useChimeUnlock } = await load();

    render(() => useChimeUnlock(true));

    expect(addEventListener.mock.calls.map(([type]) => type)).toEqual([
      "pointerdown",
      "keydown",
    ]);

    // Fire the captured unlock gesture: it resumes audio and detaches both
    // listeners so the unlock only happens once per session.
    const unlock = addEventListener.mock.calls[0]?.[1];
    unlock?.();
    expect(contexts[0]?.resume).toHaveBeenCalledTimes(1);
    expect(removeEventListener.mock.calls.map(([type]) => type)).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("arms nothing when the context is already running", async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener: vi.fn() });
    stubAudioContext("running");
    const { useChimeUnlock } = await load();

    render(() => useChimeUnlock(true));

    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("arms nothing when notifications are disabled", async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener: vi.fn() });
    stubAudioContext("suspended");
    const { useChimeUnlock } = await load();

    render(() => useChimeUnlock(false));

    expect(addEventListener).not.toHaveBeenCalled();
  });
});

const agent = (name: string, status: string) => ({
  name,
  status,
  displayName: `task ${name}`,
});

describe("useCompletionAlerts", () => {
  it("seeds silently: agents already terminal on first render don't alert", async () => {
    const env = stubAlertEnv();
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));

    expect(env.constructed).not.toHaveBeenCalled();
    expect(env.contexts).toHaveLength(0); // no chime either
  });

  it("alerts with a notification and chime when an agent finishes", async () => {
    const env = stubAlertEnv();
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));

    expect(env.constructed).toHaveBeenCalledTimes(1);
    expect(env.constructed).toHaveBeenCalledWith("Agent finished", {
      body: "task a",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "complete:a",
    });
    // The chime is two short ascending sine notes.
    expect(env.oscillators.map((o) => o.frequency.value)).toEqual([
      880, 1318.5,
    ]);
    for (const osc of env.oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
    }
  });

  it("titles the alert 'Agent failed' for a failed transition", async () => {
    const env = stubAlertEnv();
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    render(() => useCompletionAlerts([agent("a", "Failed")], true));

    expect(env.constructed).toHaveBeenCalledWith(
      "Agent failed",
      expect.objectContaining({ tag: "complete:a" }),
    );
  });

  it("fires once per transition, not on every terminal-state render", async () => {
    const env = stubAlertEnv();
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));
    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));

    expect(env.constructed).toHaveBeenCalledTimes(1);
  });

  it("ignores an agent that first appears already terminal after the seed", async () => {
    const env = stubAlertEnv();
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([], true));
    // prev === undefined: never seen Running, so no transition to report.
    render(() => useCompletionAlerts([agent("late", "Succeeded")], true));

    expect(env.constructed).not.toHaveBeenCalled();
  });

  it("stays silent when disabled, and the baseline still advances", async () => {
    const env = stubAlertEnv();
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], false));
    render(() => useCompletionAlerts([agent("a", "Succeeded")], false));
    expect(env.constructed).not.toHaveBeenCalled();

    // Re-enabling later must not retroactively fire for the missed transition.
    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));
    expect(env.constructed).not.toHaveBeenCalled();
  });

  it("skips the chime (but not the notification) in an installed PWA", async () => {
    const env = stubAlertEnv({ standalone: true });
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));

    expect(env.constructed).toHaveBeenCalledTimes(1);
    expect(env.contexts).toHaveLength(0); // Web Audio never touched
  });
});

const waiting = (name: string, awaitingInput: boolean) => ({
  name,
  awaitingInput,
  displayName: `task ${name}`,
});

describe("useAwaitingInputAlerts", () => {
  it("seeds silently: an already-waiting agent doesn't alert on load", async () => {
    const env = stubAlertEnv();
    const { useAwaitingInputAlerts } = await load();

    render(() => useAwaitingInputAlerts([waiting("a", true)], true));

    expect(env.constructed).not.toHaveBeenCalled();
    expect(env.contexts).toHaveLength(0);
  });

  it("alerts when an agent starts waiting for input", async () => {
    const env = stubAlertEnv();
    const { useAwaitingInputAlerts } = await load();

    render(() => useAwaitingInputAlerts([waiting("a", false)], true));
    render(() => useAwaitingInputAlerts([waiting("a", true)], true));

    expect(env.constructed).toHaveBeenCalledTimes(1);
    expect(env.constructed).toHaveBeenCalledWith("Agent waiting for input", {
      body: "task a",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "await:a",
    });
    expect(env.oscillators).toHaveLength(2); // chime played
  });

  it("alerts for an agent that first appears already waiting after the seed", async () => {
    const env = stubAlertEnv();
    const { useAwaitingInputAlerts } = await load();

    render(() => useAwaitingInputAlerts([], true));
    // Unlike completions, !prev treats a brand-new waiting agent as a
    // transition — it needs the user's attention regardless of history.
    render(() => useAwaitingInputAlerts([waiting("b", true)], true));

    expect(env.constructed).toHaveBeenCalledTimes(1);
    expect(env.constructed).toHaveBeenCalledWith(
      "Agent waiting for input",
      expect.objectContaining({ tag: "await:b" }),
    );
  });

  it("does not re-alert while the agent keeps waiting", async () => {
    const env = stubAlertEnv();
    const { useAwaitingInputAlerts } = await load();

    render(() => useAwaitingInputAlerts([waiting("a", false)], true));
    render(() => useAwaitingInputAlerts([waiting("a", true)], true));
    render(() => useAwaitingInputAlerts([waiting("a", true)], true));

    expect(env.constructed).toHaveBeenCalledTimes(1);
  });

  it("stays silent when disabled", async () => {
    const env = stubAlertEnv();
    const { useAwaitingInputAlerts } = await load();

    render(() => useAwaitingInputAlerts([waiting("a", false)], false));
    render(() => useAwaitingInputAlerts([waiting("a", true)], false));

    expect(env.constructed).not.toHaveBeenCalled();
    expect(env.contexts).toHaveLength(0);
  });
});
