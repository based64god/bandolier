"use client";

import { stringLocalStoragePref } from "./local-storage-pref";

// ── Preferred effort (per-browser, persisted in localStorage) ──────────────────
//
// A dashboard-only default for the reasoning-effort picker, alongside the
// preferred model (see [[preferred-model]]). Read purely client-side and never
// sent to the server, so webhook-spawned tasks — which resolve their own effort
// on the backend — are unaffected. Empty string means "no preference".

export const usePreferredEffort = stringLocalStoragePref(
  "bandolier:preferred-effort",
);
