"use client";

import { stringLocalStoragePref } from "./local-storage-pref";

// ── Preferred model (per-browser, persisted in localStorage) ───────────────────
//
// This is a dashboard-only default: it seeds the deploy modal's model picker so
// the user doesn't have to re-pick their go-to model every time. It is read
// purely client-side and never reaches the server, so webhook-spawned tasks —
// which resolve their model on the backend — are unaffected by design. An empty
// string means "no preference set".

export const usePreferredModel = stringLocalStoragePref(
  "bandolier:preferred-model",
);
