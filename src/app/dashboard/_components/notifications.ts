"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { api } from "~/trpc/react";

const PREF_KEY = "bandolier:notify";

type AlertAgent = { name: string; status: string; displayName: string };

const isTerminal = (status: string) =>
  status === "Succeeded" || status === "Failed";

// ── Preference (per-browser, persisted in localStorage) ────────────────────────

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

/**
 * Reads/writes the notification preference via useSyncExternalStore so it's
 * hydration-safe (server snapshot is false) and updates without a sync effect.
 */
export function useNotifyPref(): [boolean, (value: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(PREF_KEY) === "1",
    () => false,
  );
  const set = (value: boolean) => {
    localStorage.setItem(PREF_KEY, value ? "1" : "0");
    // The native "storage" event only fires in other tabs; nudge this one too.
    window.dispatchEvent(new StorageEvent("storage"));
  };
  return [enabled, set];
}

// ── Chime (Web Audio, no asset needed) ─────────────────────────────────────────

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  audioCtx ??= new AudioContext();
  return audioCtx;
}

/** Resume the audio context from within a user gesture so chimes can play. */
export function primeAudio() {
  void ctx()?.resume();
}

/**
 * Browsers start every AudioContext suspended and only resume it from within a
 * user gesture. `primeAudio` covers the gesture that flips the toggle on, but
 * the preference is persisted — on every later visit `notify` is already true,
 * so the toggle is never clicked and the context stays suspended, leaving the
 * chime silent. This hook re-arms the unlock: while notifications are enabled it
 * primes audio on the next user gesture of the session, then detaches.
 */
export function useChimeUnlock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    // Already running (primed earlier this session) — nothing to arm.
    if (ctx()?.state === "running") return;
    const unlock = () => {
      primeAudio();
      remove();
    };
    const remove = () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return remove;
  }, [enabled]);
}

function playChime() {
  const ac = ctx();
  if (!ac) return;
  void ac.resume();
  const now = ac.currentTime;
  // Two short ascending notes.
  [880, 1318.5].forEach((freq, i) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ac.destination);
    const t = now + i * 0.14;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.start(t);
    osc.stop(t + 0.27);
  });
}

// ── Native system notifications ────────────────────────────────────────────────

/** True when running as an installed PWA (standalone display mode). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari uses a non-standard navigator.standalone flag.
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

/**
 * Shows an OS-level notification. Prefers the service worker's showNotification
 * — required in installed PWAs, where the Notification constructor is
 * unavailable on some platforms — and falls back to the constructor in a plain
 * browser tab. No-op without granted permission.
 */
async function showNativeNotification(
  title: string,
  body: string,
  tag: string,
) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  const options: NotificationOptions = {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag,
  };
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return;
    }
  } catch {
    // Fall through to the constructor.
  }
  try {
    new Notification(title, options);
  } catch {
    // Some installed PWAs forbid the constructor entirely; nothing else to do.
  }
}

/** Requests notification permission; call from a user gesture (the toggle). */
export async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

// ── Web Push subscription (background notifications) ─────────────────────────────

/**
 * Web Push delivers notifications through the service worker even when no tab is
 * open — the piece the in-tab alerts above can't do. Subscribing requires a
 * server VAPID public key; this hook registers the browser's PushSubscription
 * with the server while notifications are enabled and removes it when they're
 * turned off. It's a no-op when the browser lacks push support or the server has
 * no VAPID keypair configured (config.enabled === false).
 */

/** Decodes a base64url VAPID key into the ArrayBuffer PushManager expects. */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/** ArrayBuffer → base64url, for the p256dh/auth keys sent to the server. */
function bufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * Keeps the browser's push subscription in sync with the notification toggle.
 * Enabling subscribes (creating one with the server's VAPID key if needed) and
 * registers it server-side; disabling unregisters and unsubscribes. Both are
 * best-effort — a failure here never blocks the in-tab alerts.
 */
export function usePushSubscription(enabled: boolean) {
  const { data: config } = api.push.config.useQuery(undefined, {
    // The VAPID key is process-stable; no need to refetch.
    staleTime: Infinity,
  });
  // react-query's mutateAsync is referentially stable across renders, so it's
  // safe to depend on directly without refs.
  const { mutateAsync: subscribe } = api.push.subscribe.useMutation();
  const { mutateAsync: unsubscribe } = api.push.unsubscribe.useMutation();
  const publicKey = config?.publicKey ?? null;
  const pushEnabled = config?.enabled ?? false;

  useEffect(() => {
    if (!pushSupported() || !pushEnabled || !publicKey) return;
    let cancelled = false;

    async function sync() {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();

      if (!enabled) {
        // Notifications off — drop the subscription server-side, then locally.
        if (existing) {
          try {
            await unsubscribe({ endpoint: existing.endpoint });
          } catch {
            // Best-effort; still unsubscribe the browser below.
          }
          await existing.unsubscribe().catch(() => undefined);
        }
        return;
      }

      // Notifications on, but permission not granted — can't subscribe.
      if (Notification.permission !== "granted") return;

      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(publicKey!),
        }));
      if (cancelled) return;

      const json = sub.toJSON();
      const p256dh =
        json.keys?.p256dh ?? bufferToBase64Url(sub.getKey("p256dh"));
      const auth = json.keys?.auth ?? bufferToBase64Url(sub.getKey("auth"));
      if (!p256dh || !auth) return;

      await subscribe({ endpoint: sub.endpoint, p256dh, auth }).catch(
        () => undefined,
      );
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [enabled, pushEnabled, publicKey, subscribe, unsubscribe]);
}

// ── Completion detection ───────────────────────────────────────────────────────

/**
 * Fires a chime + system notification when an agent transitions into a terminal
 * state. The first observed list seeds a baseline so pre-existing finished tasks
 * don't alert on load.
 */
export function useCompletionAlerts(agents: AlertAgent[], enabled: boolean) {
  const seen = useRef<Map<string, string>>(new Map());
  const seeded = useRef(false);

  useEffect(() => {
    if (!seeded.current) {
      for (const a of agents) seen.current.set(a.name, a.status);
      seeded.current = true;
      return;
    }

    for (const a of agents) {
      const prev = seen.current.get(a.name);
      const newlyDone =
        prev !== undefined && !isTerminal(prev) && isTerminal(a.status);
      if (newlyDone && enabled) {
        const ok = a.status === "Succeeded";
        void showNativeNotification(
          ok ? "Agent finished" : "Agent failed",
          a.displayName,
          `complete:${a.name}`,
        );
        // Installed PWAs rely on the native notification (and may be
        // backgrounded, where Web Audio is throttled); chime only in a tab.
        if (!isStandalone()) playChime();
      }
      seen.current.set(a.name, a.status);
    }
  }, [agents, enabled]);
}

// ── Awaiting-input detection (interactive agents) ──────────────────────────────

type InputAgent = { name: string; awaitingInput: boolean; displayName: string };

/**
 * Fires a chime + system notification when an interactive agent transitions into
 * the "waiting for input" state. The first observed list seeds a baseline so an
 * already-waiting agent doesn't alert on load.
 */
export function useAwaitingInputAlerts(agents: InputAgent[], enabled: boolean) {
  const seen = useRef<Map<string, boolean>>(new Map());
  const seeded = useRef(false);

  useEffect(() => {
    if (!seeded.current) {
      for (const a of agents) seen.current.set(a.name, a.awaitingInput);
      seeded.current = true;
      return;
    }

    for (const a of agents) {
      const prev = seen.current.get(a.name);
      // Alert on a transition into waiting (or an agent that appears already
      // waiting after the initial seed), once per transition.
      if (!prev && a.awaitingInput && enabled) {
        void showNativeNotification(
          "Agent waiting for input",
          a.displayName,
          `await:${a.name}`,
        );
        if (!isStandalone()) playChime();
      }
      seen.current.set(a.name, a.awaitingInput);
    }
  }, [agents, enabled]);
}
