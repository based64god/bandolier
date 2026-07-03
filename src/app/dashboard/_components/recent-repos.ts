"use client";

import { useSyncExternalStore } from "react";

// ── Recently visited repos (per-browser, persisted in localStorage) ────────────
//
// The dashboard records a visit whenever a repo resolves from the URL, and the
// repo dropdown surfaces the most recent ones in a "Recent" group above the
// full list. Like the cookie view prefs, this is per-browser rather than
// per-account so shared links don't carry the sender's history.

const STORAGE_KEY = "bandolier:recent-repos";
const MAX_RECENT = 5;

const listeners = new Set<() => void>();

const EMPTY: string[] = [];

// useSyncExternalStore compares snapshots by reference, so cache the parsed
// array and only re-parse when the raw string actually changes.
let cachedRaw: string | null = null;
let cachedList: string[] = EMPTY;

function parse(raw: string | null): string[] {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

function read(): string[] {
  if (typeof window === "undefined") return EMPTY;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = parse(raw);
  }
  return cachedList;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // `storage` only fires for writes from other tabs; same-tab writes notify
  // subscribers directly in recordRecentRepo.
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

/** Moves (or inserts) a repo at the front of the recent list, capped at 5. */
export function recordRecentRepo(fullName: string) {
  const next = [fullName, ...read().filter((r) => r !== fullName)].slice(
    0,
    MAX_RECENT,
  );
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const cb of listeners) cb();
}

/** Recently visited repo fullNames, most recent first. */
export function useRecentRepos(): string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
