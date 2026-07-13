"use client";

import { useEffect } from "react";

// How often to ask the browser to check for a new service worker while the app
// is open, so long-lived PWA sessions notice deploys without a manual reload.
const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Registers the service worker (public/sw.js) on the client. Rendered once from
 * the root layout. Registration only runs in the browser when the API exists,
 * so it's a no-op during SSR and in unsupported browsers.
 *
 * Also wires up update handling: it periodically asks the browser to re-check
 * for a new worker, and reloads the page once a new worker takes control (after
 * the update prompt's "Refresh" tells it to skip waiting) so the freshly cached
 * assets are actually used.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let updateTimer: ReturnType<typeof setInterval> | undefined;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          // Nudge the browser to look for a new sw.js now and on an interval.
          void reg.update();
          updateTimer = setInterval(
            () => void reg.update(),
            SW_UPDATE_INTERVAL_MS,
          );
        })
        .catch((error) => {
          console.error("Service worker registration failed:", error);
        });
    };

    // When a new worker activates and takes control, reload once so the page
    // runs against the freshly cached assets. Two guards: never loop, and ignore
    // the spurious controllerchange the very first worker fires when it claims
    // an uncontrolled page (no prior controller → not an update).
    let reloading = false;
    const hadController = Boolean(navigator.serviceWorker.controller);
    const onControllerChange = () => {
      if (reloading || !hadController) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    const cleanup = () => {
      if (updateTimer) clearInterval(updateTimer);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };

    if (document.readyState === "complete") {
      register();
      return cleanup;
    }
    window.addEventListener("load", register);
    return () => {
      window.removeEventListener("load", register);
      cleanup();
    };
  }, []);

  return null;
}
