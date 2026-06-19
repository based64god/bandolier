"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The build id this client was served with, baked into the bundle at build time
// (next.config.js → env.NEXT_PUBLIC_BUILD_ID). Comparing it against the live
// server's build id (GET /api/version) tells us when a newer build is deployed.
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

// How often to poll the version endpoint while the tab is visible.
const POLL_INTERVAL_MS = 60_000;

/**
 * Polls /api/version and reports true once the running server's build id differs
 * from the one this client was served with — i.e. a new version was deployed and
 * the UI is now out of date.
 *
 * Polling pauses while the tab is hidden and runs an immediate check whenever the
 * tab becomes visible again (covering laptops resumed from sleep). Network errors
 * are swallowed: a failed poll just means "don't know yet", never a false prompt.
 */
function useServerBuildOutdated(): boolean {
  const [outdated, setOutdated] = useState(false);

  useEffect(() => {
    // In dev the build id is unstable across reloads; skip to avoid noise.
    if (BUILD_ID === "dev") return;

    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        if (!cancelled && data.buildId && data.buildId !== BUILD_ID) {
          setOutdated(true);
        }
      } catch {
        // Offline or transient failure — try again on the next tick.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    void check();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return outdated;
}

/**
 * Watches the service worker registration for a newly-installed worker waiting to
 * activate — a second, PWA-native signal that fresh assets are available. Returns
 * a ref to the waiting worker (so the refresh can tell it to skip waiting) and a
 * boolean that flips true once one is waiting.
 */
function useWaitingWorker(): {
  waiting: boolean;
  activate: () => void;
} {
  const [waiting, setWaiting] = useState(false);
  const workerRef = useRef<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    const track = (worker: ServiceWorker | null) => {
      if (worker && !cancelled) {
        workerRef.current = worker;
        setWaiting(true);
      }
    };

    void navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg || cancelled) return;
      // A worker already waiting when we mounted.
      track(reg.waiting);
      // Or one that finishes installing while the page is open.
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (
            installing.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            track(reg.waiting ?? installing);
          }
        });
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const activate = useCallback(() => {
    // Ask the waiting worker to take over; the controllerchange listener in
    // PwaRegister reloads the page once it does.
    workerRef.current?.postMessage({ type: "SKIP_WAITING" });
  }, []);

  return { waiting, activate };
}

/**
 * A dismissible banner shown when the client is out of date — either the deployed
 * build id changed (works in any browser tab) or the service worker has a newer
 * version waiting (installed PWA). Clicking "Refresh" activates any waiting worker
 * and reloads the page so the user gets the latest UI.
 *
 * Rendered once from the root layout, so it covers both the website and the PWA.
 */
export function UpdatePrompt() {
  const serverOutdated = useServerBuildOutdated();
  const { waiting, activate } = useWaitingWorker();
  const [dismissed, setDismissed] = useState(false);

  const show = (serverOutdated || waiting) && !dismissed;
  if (!show) return null;

  const refresh = () => {
    activate();
    window.location.reload();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex w-full max-w-md items-center gap-3 rounded-xl border border-white/10 bg-[#0a2014]/95 px-4 py-3 text-sm text-white shadow-lg backdrop-blur">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 shrink-0 text-white/70"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        <span className="flex-1 text-white/90">
          A new version of Bandolier is available.
        </span>
        <button
          onClick={refresh}
          className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 font-medium text-white hover:bg-white/20"
        >
          Refresh
        </button>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="rounded-lg px-1.5 py-1.5 text-white/50 hover:text-white"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
