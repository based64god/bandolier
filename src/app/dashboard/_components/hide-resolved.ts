"use client";

import { useSyncExternalStore } from "react";

const COOKIE_KEY = "bandolier:hide-resolved";

// ── Hide-resolved filter (per-browser, persisted in a cookie) ──────────────────
//
// This is a view preference: it drops tasks whose output has reached a terminal
// state on GitHub (a merged/closed PR or a closed/completed issue). It lives in
// a cookie rather than the URL so it is independent of the selected repo and is
// not carried into shared links — the recipient sees their own preference, not
// the sender's filtered view.

function readCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split("; ").some((c) => c === `${COOKIE_KEY}=1`);
}

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Reads/writes the hide-resolved preference via useSyncExternalStore so it's
 * hydration-safe (server snapshot is false) and updates without a sync effect.
 * Cookies don't emit a change event, so writes notify subscribers directly.
 */
export function useHideResolved(): [boolean, (value: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, readCookie, () => false);
  const set = (value: boolean) => {
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = value
      ? `${COOKIE_KEY}=1; path=/; max-age=${oneYear}; samesite=lax`
      : `${COOKIE_KEY}=; path=/; max-age=0; samesite=lax`;
    for (const cb of listeners) cb();
  };
  return [enabled, set];
}
