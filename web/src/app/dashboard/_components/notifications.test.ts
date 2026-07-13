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
  cleanups: [] as (() => void)[],
}));

vi.mock("react", () => ({
  useSyncExternalStore: (
    _subscribe: (cb: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => getSnapshot(),
  useRef: (initial: unknown) =>
    (fakeReact.refs[fakeReact.refIndex++] ??= { current: initial }),
  // Run the effect immediately and stash any returned cleanup so a test can
  // drive an "unmount" (React would call the cleanup then) — useBackgroundPush
  // uses one to cancel its in-flight async work.
  useEffect: (effect: () => unknown) => {
    const cleanup = effect();
    if (typeof cleanup === "function")
      fakeReact.cleanups.push(cleanup as () => void);
  },
}));

// useBackgroundPush pulls the push subscribe/unsubscribe mutations off the tRPC
// client. Mock it so the hook gets a `{ mutate }` it can call without a real
// React-Query context; the two spies capture exactly what it persists /
// forgets server-side. useMutation is invoked at render time (well after these
// consts initialise), so the factory referencing them lazily dodges the mock's
// hoisting TDZ.
const saveSubMutate =
  vi.fn<
    (input: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    }) => void
  >();
const dropSubMutate = vi.fn<(input: { endpoint: string }) => void>();
vi.mock("~/trpc/react", () => ({
  api: {
    push: {
      subscribe: { useMutation: () => ({ mutate: saveSubMutate }) },
      unsubscribe: { useMutation: () => ({ mutate: dropSubMutate }) },
    },
  },
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

/**
 * Alert environment whose navigator exposes a service worker — the branch
 * showNativeNotification prefers over the Notification constructor (required in
 * installed PWAs). `ready` resolves a registration with a controllable
 * showNotification; `rejectShow` makes it throw so the fall-through to the
 * constructor can be exercised.
 */
function stubServiceWorkerEnv({
  standalone = false,
  permission = "granted",
  rejectShow = false,
}: {
  standalone?: boolean;
  permission?: "default" | "granted" | "denied";
  rejectShow?: boolean;
} = {}) {
  const showNotification = vi.fn<
    (title: string, options: NotificationOptions) => Promise<void>
  >(() =>
    rejectShow
      ? Promise.reject(new Error("SW notifications forbidden"))
      : Promise.resolve(),
  );
  const navigator = {
    serviceWorker: { ready: Promise.resolve({ showNotification }) },
  };
  vi.stubGlobal("navigator", navigator);
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({ matches: standalone })),
    navigator,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return {
    showNotification,
    ...stubNotification(permission),
    ...stubAudioContext(),
  };
}

// A canonical web-push VAPID public key (URL-safe base64, exercises the `-`
// substitution and the two-char padding urlBase64ToUint8Array computes).
const VAPID =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8";

type PushSubJson = {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};
type FakePushSub = {
  endpoint: string;
  toJSON: () => PushSubJson;
  unsubscribe: ReturnType<typeof vi.fn>;
};

/** A PushSubscription stand-in: the module reads .endpoint, .toJSON(), .unsubscribe(). */
function makePushSub(
  endpoint: string,
  keys: { p256dh?: string; auth?: string } | null,
): FakePushSub {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: keys ?? undefined }),
    unsubscribe: vi.fn(() => Promise.resolve()),
  };
}

/**
 * Environment for useBackgroundPush: a window advertising PushManager, a
 * navigator whose serviceWorker.ready resolves a registration with a
 * controllable pushManager, and a Notification permission. VAPID_PUBLIC_KEY is
 * supplied separately via vi.stubEnv before load() so pushSupported() sees it.
 */
function stubPushEnv({
  permission = "granted",
  existing = null,
  fresh = null,
  hasPushManager = true,
}: {
  permission?: "default" | "granted" | "denied";
  existing?: FakePushSub | null;
  fresh?: FakePushSub | null;
  hasPushManager?: boolean;
} = {}) {
  const getSubscription = vi.fn<() => Promise<FakePushSub | null>>(() =>
    Promise.resolve(existing),
  );
  const subscribe = vi.fn<
    (opts: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    }) => Promise<FakePushSub>
  >(() => Promise.resolve(fresh!));
  const navigator = {
    serviceWorker: {
      ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }),
    },
  };
  vi.stubGlobal("navigator", navigator);
  const win: Record<string, unknown> = { navigator };
  if (hasPushManager) win.PushManager = class {};
  vi.stubGlobal("window", win);
  return { getSubscription, subscribe, ...stubNotification(permission) };
}

// The alert hooks and useBackgroundPush fire-and-forget an async chain that
// awaits navigator.serviceWorker.ready before touching the notification /
// subscription. Yield past the microtask + macrotask boundary so that chain
// settles before asserting.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The module caches its AudioContext at module level; re-import per test so
// the cache — and the fake refs backing the hooks — start fresh.
async function load() {
  return import("~/app/dashboard/_components/notifications");
}

beforeEach(() => {
  vi.resetModules();
  fakeReact.refs = [];
  fakeReact.refIndex = 0;
  fakeReact.cleanups = [];
  saveSubMutate.mockReset();
  dropSubMutate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

// showNativeNotification is private; drive it through a completion transition.
// The interesting, previously-uncovered branch is the service-worker path an
// installed PWA takes, plus its fall-throughs.
describe("showNativeNotification (service worker path)", () => {
  it("prefers the service worker's showNotification over the constructor", async () => {
    const env = stubServiceWorkerEnv();
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));
    await flush();

    expect(env.showNotification).toHaveBeenCalledTimes(1);
    expect(env.showNotification).toHaveBeenCalledWith("Agent finished", {
      body: "task a",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "complete:a",
    });
    // The constructor is the fallback only; with a service worker present it's
    // never touched.
    expect(env.constructed).not.toHaveBeenCalled();
  });

  it("falls back to the constructor when the service worker rejects", async () => {
    const env = stubServiceWorkerEnv({ rejectShow: true });
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    render(() => useCompletionAlerts([agent("a", "Failed")], true));
    await flush();

    // reg.showNotification threw; the catch drops through to the constructor.
    expect(env.showNotification).toHaveBeenCalledTimes(1);
    expect(env.constructed).toHaveBeenCalledWith(
      "Agent failed",
      expect.objectContaining({ tag: "complete:a" }),
    );
  });

  it("is a no-op without granted permission, even with a service worker", async () => {
    const env = stubServiceWorkerEnv({ permission: "denied" });
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    render(() => useCompletionAlerts([agent("a", "Succeeded")], true));
    await flush();

    expect(env.showNotification).not.toHaveBeenCalled();
    expect(env.constructed).not.toHaveBeenCalled();
  });

  it("swallows a constructor that some installed PWAs forbid", async () => {
    // Bare navigator (no serviceWorker) forces the constructor path; a PWA that
    // forbids `new Notification` must not crash the alert — the contract is a
    // silent no-op, not a throw.
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })), // standalone: skip the chime
      navigator: {},
    });
    class ThrowingNotification {
      static permission = "granted" as const;
      constructor() {
        throw new Error("constructor forbidden");
      }
    }
    vi.stubGlobal("Notification", ThrowingNotification);
    const { useCompletionAlerts } = await load();

    render(() => useCompletionAlerts([agent("a", "Running")], true));
    expect(() =>
      render(() => useCompletionAlerts([agent("a", "Succeeded")], true)),
    ).not.toThrow();
  });
});

describe("useBackgroundPush", () => {
  it("is a no-op when the VAPID public key is unset", async () => {
    // Empty string → env treats it as undefined → pushSupported() is false, so
    // the subscription machinery is never touched regardless of enabled state.
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    const env = stubPushEnv();
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(true));
    await flush();

    expect(env.getSubscription).not.toHaveBeenCalled();
    expect(saveSubMutate).not.toHaveBeenCalled();
    expect(dropSubMutate).not.toHaveBeenCalled();
  });

  it("is a no-op when the browser lacks PushManager", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    const env = stubPushEnv({ hasPushManager: false });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(true));
    await flush();

    expect(env.getSubscription).not.toHaveBeenCalled();
    expect(saveSubMutate).not.toHaveBeenCalled();
  });

  it("subscribes and persists the endpoint + keys when enabled and granted", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    const fresh = makePushSub("https://push.example/new", {
      p256dh: "PUBK",
      auth: "AUTHK",
    });
    const env = stubPushEnv({ existing: null, fresh });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(true));
    await flush();

    // No existing subscription → it subscribes, converting the URL-safe base64
    // VAPID key to the byte array the browser wants (urlBase64ToUint8Array).
    expect(env.subscribe).toHaveBeenCalledTimes(1);
    const opts = env.subscribe.mock.calls[0]?.[0];
    expect(opts?.userVisibleOnly).toBe(true);
    expect(Array.from(opts?.applicationServerKey ?? new Uint8Array())).toEqual(
      Array.from(Buffer.from(VAPID, "base64url")),
    );
    expect(saveSubMutate).toHaveBeenCalledWith({
      endpoint: "https://push.example/new",
      keys: { p256dh: "PUBK", auth: "AUTHK" },
    });
    expect(dropSubMutate).not.toHaveBeenCalled();
  });

  it("reuses an existing subscription instead of re-subscribing", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    const existing = makePushSub("https://push.example/existing", {
      p256dh: "EPK",
      auth: "EAK",
    });
    const env = stubPushEnv({ existing });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(true));
    await flush();

    expect(env.subscribe).not.toHaveBeenCalled();
    expect(saveSubMutate).toHaveBeenCalledWith({
      endpoint: "https://push.example/existing",
      keys: { p256dh: "EPK", auth: "EAK" },
    });
  });

  it("does not persist when the subscription JSON is missing a key", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    // Endpoint present but no `auth` key → the guard rejects the incomplete
    // subscription rather than saving a half-formed one.
    const existing = makePushSub("https://push.example/partial", {
      p256dh: "only",
    });
    const env = stubPushEnv({ existing });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(true));
    await flush();

    expect(env.subscribe).not.toHaveBeenCalled();
    expect(saveSubMutate).not.toHaveBeenCalled();
  });

  it("does not subscribe when enabled but permission isn't granted", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    const env = stubPushEnv({
      permission: "default",
      existing: makePushSub("https://push.example/x", {
        p256dh: "x",
        auth: "y",
      }),
    });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(true));
    await flush();

    // Bails before ever asking for a subscription.
    expect(env.getSubscription).not.toHaveBeenCalled();
    expect(saveSubMutate).not.toHaveBeenCalled();
  });

  it("tears down the subscription and forgets it server-side when disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    const existing = makePushSub("https://push.example/drop", {
      p256dh: "x",
      auth: "y",
    });
    stubPushEnv({ existing });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(false));
    await flush();

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(dropSubMutate).toHaveBeenCalledWith({
      endpoint: "https://push.example/drop",
    });
    expect(saveSubMutate).not.toHaveBeenCalled();
  });

  it("is a no-op when disabled and there is no subscription to drop", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    const env = stubPushEnv({ existing: null });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(false));
    await flush();

    expect(env.getSubscription).toHaveBeenCalledTimes(1);
    expect(dropSubMutate).not.toHaveBeenCalled();
  });

  it("abandons the in-flight subscription when unmounted before it resolves", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID);
    const fresh = makePushSub("https://push.example/new", {
      p256dh: "PUBK",
      auth: "AUTHK",
    });
    const env = stubPushEnv({ existing: null, fresh });
    const { useBackgroundPush } = await load();

    render(() => useBackgroundPush(true));
    // Unmount (React runs the effect cleanup) before serviceWorker.ready has
    // settled: the `cancelled` guard must swallow the resolved subscription so a
    // gone component never persists one.
    fakeReact.cleanups.forEach((cleanup) => cleanup());
    await flush();

    expect(env.getSubscription).not.toHaveBeenCalled();
    expect(saveSubMutate).not.toHaveBeenCalled();
  });
});
