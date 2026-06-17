"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js) on the client. Rendered once from
 * the root layout. Registration only runs in the browser when the API exists,
 * so it's a no-op during SSR and in unsupported browsers.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.error("Service worker registration failed:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
