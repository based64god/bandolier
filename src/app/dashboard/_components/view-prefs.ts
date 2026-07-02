"use client";

import { useSyncExternalStore } from "react";

// ── Boolean view preferences (per-browser, persisted in cookies) ───────────────
//
// View preferences for the task list. They live in cookies rather than the URL
// so they are independent of the selected repo and are not carried into shared
// links — the recipient sees their own preference, not the sender's filtered
// view.

/**
 * Builds a hydration-safe boolean-preference hook backed by a cookie: reads via
 * useSyncExternalStore (server snapshot is false) and updates without a sync
 * effect. Cookies don't emit a change event, so writes notify subscribers
 * directly; each preference keeps its own subscriber set.
 */
function booleanCookiePref(cookieKey: string) {
  const listeners = new Set<() => void>();

  function read(): boolean {
    if (typeof document === "undefined") return false;
    return document.cookie.split("; ").some((c) => c === `${cookieKey}=1`);
  }

  function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  return function usePref(): [boolean, (value: boolean) => void] {
    const enabled = useSyncExternalStore(subscribe, read, () => false);
    const set = (value: boolean) => {
      const oneYear = 60 * 60 * 24 * 365;
      document.cookie = value
        ? `${cookieKey}=1; path=/; max-age=${oneYear}; samesite=lax`
        : `${cookieKey}=; path=/; max-age=0; samesite=lax`;
      for (const cb of listeners) cb();
    };
    return [enabled, set];
  };
}

/**
 * Drops tasks whose output has reached a terminal state on GitHub (a
 * merged/closed PR or a closed/completed issue).
 */
export const useHideResolved = booleanCookiePref("bandolier:hide-resolved");

/**
 * Drops collaborators' tasks, showing only the viewer's own. Repo views list
 * every collaborator's tasks; this narrows back to a personal view.
 */
export const useOnlyMine = booleanCookiePref("bandolier:only-mine");
