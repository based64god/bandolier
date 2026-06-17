"use client";

import { useSyncExternalStore } from "react";

const PREF_KEY = "bandolier:preferred-model";

// ── Preferred model (per-browser, persisted in localStorage) ───────────────────
//
// This is a dashboard-only default: it seeds the deploy modal's model picker so
// the user doesn't have to re-pick their go-to model every time. It is read
// purely client-side and never reaches the server, so webhook-spawned tasks —
// which resolve their model on the backend — are unaffected by design.

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

/**
 * Reads/writes the preferred model id via useSyncExternalStore so it's
 * hydration-safe (server snapshot is "") and updates without a sync effect. An
 * empty string means "no preference set".
 */
export function usePreferredModel(): [string, (value: string) => void] {
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
