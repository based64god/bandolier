"use client";

import { useSyncExternalStore } from "react";

const PREF_KEY = "bandolier:preferred-effort";

// ── Preferred effort (per-browser, persisted in localStorage) ──────────────────
//
// A dashboard-only default for the reasoning-effort picker, alongside the
// preferred model (see [[preferred-model]]). Read purely client-side and never
// sent to the server, so webhook-spawned tasks — which resolve their own effort
// on the backend — are unaffected. Empty string means "no preference".

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

/**
 * Reads/writes the preferred effort level via useSyncExternalStore so it's
 * hydration-safe (server snapshot is "") and updates without a sync effect.
 */
export function usePreferredEffort(): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(PREF_KEY) ?? "",
    () => "",
  );
  const set = (next: string) => {
    if (next) localStorage.setItem(PREF_KEY, next);
    else localStorage.removeItem(PREF_KEY);
    // The native "storage" event only fires in other tabs; nudge this one too.
    window.dispatchEvent(new StorageEvent("storage"));
  };
  return [value, set];
}
