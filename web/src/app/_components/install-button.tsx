"use client";

import { useEffect, useState } from "react";

/**
 * The `beforeinstallprompt` event isn't part of the standard DOM lib types.
 * It's fired by Chromium browsers when the PWA is installable.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Renders an "Install app" button when the browser reports the PWA is
 * installable. Renders nothing once installed or in browsers that don't fire
 * `beforeinstallprompt` (e.g. iOS Safari, where install is a manual Share-sheet
 * action).
 */
export function InstallButton() {
  const [promptEvent, setPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      // Stop Chrome's default mini-infobar so we can trigger the prompt from
      // our own button instead.
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!promptEvent) return null;

  const handleClick = async () => {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    // The prompt can only be used once; drop it regardless of the choice.
    if (outcome === "accepted") setPromptEvent(null);
  };

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-white/70 hover:bg-white/10 hover:text-white"
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
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      Install app
    </button>
  );
}
