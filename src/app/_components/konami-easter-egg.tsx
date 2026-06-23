"use client";

import { useEffect, useState } from "react";

/*
 * Easter egg: the Konami code (↑ ↑ ↓ ↓ ← → ← → B A) toggles "1337 h4x0r mode",
 * which adds the `.h4x0r` class to <html>. That class is what re-skins the app
 * from the default slate/purple theme into the green CRT terminal palette (see
 * the html.h4x0r block in styles/globals.css). The choice is persisted to
 * localStorage and re-applied before paint by an inline script in layout.tsx,
 * so it survives reloads without flashing the wrong theme.
 */
const KONAMI = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

export const H4X0R_STORAGE_KEY = "h4x0r";

export function KonamiEasterEgg() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let progress = 0;

    function onKeyDown(e: KeyboardEvent) {
      // Single-character keys ("b"/"a") vary by shift/caps; the arrow keys are
      // already in canonical form. Normalise so the sequence matches regardless.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (key === KONAMI[progress]) {
        progress += 1;
        if (progress === KONAMI.length) {
          progress = 0;
          toggle();
        }
      } else {
        // Wrong key: restart, but allow it to count as the first key of a fresh
        // attempt (so a stray ↑ before the real sequence doesn't break it).
        progress = key === KONAMI[0] ? 1 : 0;
      }
    }

    function toggle() {
      const root = document.documentElement;
      const enabling = !root.classList.contains("h4x0r");
      root.classList.toggle("h4x0r", enabling);
      try {
        if (enabling) localStorage.setItem(H4X0R_STORAGE_KEY, "1");
        else localStorage.removeItem(H4X0R_STORAGE_KEY);
      } catch {
        // Ignore storage failures (private mode, etc.) — the toggle still works
        // for the current session.
      }
      setMessage(
        enabling ? "switching to 1337 h4x0r mode" : "switching to n00b mode",
      );
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(1rem,env(safe-area-inset-top))] z-[10000] flex justify-center px-4">
      <div className="rounded-lg border border-purple-400/40 bg-[var(--surface-panel)] px-4 py-2 font-mono text-sm tracking-wider text-purple-200 shadow-lg">
        {message}
      </div>
    </div>
  );
}
