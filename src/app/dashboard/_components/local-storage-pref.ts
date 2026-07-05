"use client";

import { useSyncExternalStore } from "react";

// ── String preferences (per-browser, persisted in localStorage) ────────────────
//
// The localStorage counterpart to view-prefs.ts's booleanCookiePref: a factory
// for hydration-safe string preferences read purely client-side. Used by the
// dashboard's model and effort pickers (see [[preferred-model]] and
// [[preferred-effort]]).

/**
 * Builds a hydration-safe string-preference hook backed by localStorage: reads
 * via useSyncExternalStore (server snapshot is "") and updates without a sync
 * effect. An empty string means "no preference set" — set("") removes the key
 * rather than persisting an empty value. The native "storage" event only fires
 * in other tabs, so writes dispatch one locally to nudge same-tab subscribers.
 */
export function stringLocalStoragePref(key: string) {
  function subscribe(cb: () => void) {
    window.addEventListener("storage", cb);
    return () => window.removeEventListener("storage", cb);
  }

  return function usePref(): [string, (value: string) => void] {
    const value = useSyncExternalStore(
      subscribe,
      () => localStorage.getItem(key) ?? "",
      () => "",
    );
    const set = (next: string) => {
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
      window.dispatchEvent(new StorageEvent("storage"));
    };
    return [value, set];
  };
}
