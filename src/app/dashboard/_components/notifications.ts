"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

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

function systemNotification(agent: AlertAgent) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  const ok = agent.status === "Succeeded";
  new Notification(ok ? "Agent finished" : "Agent failed", {
    body: agent.displayName,
    icon: "/icon.svg",
  });
}

/** Requests notification permission; call from a user gesture (the toggle). */
export async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
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
        playChime();
        systemNotification(a);
      }
      seen.current.set(a.name, a.status);
    }
  }, [agents, enabled]);
}
