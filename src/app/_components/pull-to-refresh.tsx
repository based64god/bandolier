"use client";

import { useEffect, useRef, useState } from "react";

// How far the user must drag (in px) before releasing triggers a refresh.
const THRESHOLD = 70;
// Cap the visual pull so the indicator never travels absurdly far.
const MAX_PULL = 110;
// Dampening applied to finger travel so the pull feels rubber-banded.
const RESISTANCE = 0.5;

/**
 * True when the touch began inside a nested scrollable container (e.g. the logs
 * modal). Those elements own the gesture: pulling there should scroll the
 * container, not trigger a page refresh. Walks up from the touch target looking
 * for an ancestor that scrolls vertically and has overflow content.
 */
function isInsideScrollable(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** True when running as an installed PWA (standalone display mode). */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari uses a non-standard navigator.standalone flag.
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

/**
 * Adds a native-feeling pull-to-refresh gesture for the installed mobile PWA.
 * Drag down from the top of the page past a threshold and release to reload.
 *
 * Active only in standalone mode: browser tabs already have the browser's own
 * pull-to-refresh, so enabling it there would double up. Rendered once from the
 * root layout. Renders an indicator that follows the finger, then a spinner
 * while the reload kicks in.
 */
export function PullToRefresh() {
  const [enabled, setEnabled] = useState(false);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Gesture bookkeeping kept in refs so listeners stay stable across renders.
  const startY = useRef(0);
  const tracking = useRef(false);
  const pullRef = useRef(0);

  // Only enable in standalone PWAs (re-checked if the display mode changes).
  useEffect(() => {
    const update = () => setEnabled(isStandalone());
    update();
    const mql = window.matchMedia?.("(display-mode: standalone)");
    mql?.addEventListener?.("change", update);
    return () => mql?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const onTouchStart = (e: TouchEvent) => {
      // Begin tracking only when scrolled to the very top and not mid-refresh.
      if (refreshing || window.scrollY > 0 || e.touches.length !== 1) return;
      // Skip when the touch starts inside a scrollable element (e.g. the logs
      // modal) so its own scroll wins instead of triggering a refresh.
      if (isInsideScrollable(e.target)) return;
      startY.current = e.touches[0]?.clientY ?? 0;
      tracking.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking.current) return;
      const y = e.touches[0]?.clientY ?? 0;
      const delta = y - startY.current;
      // Cancel if the user scrolls up or the page has scrolled away from top.
      if (delta <= 0 || window.scrollY > 0) {
        tracking.current = false;
        pullRef.current = 0;
        setPull(0);
        return;
      }
      // Rubber-band the travel and suppress the native scroll while pulling.
      const distance = Math.min(delta * RESISTANCE, MAX_PULL);
      pullRef.current = distance;
      setPull(distance);
      if (e.cancelable) e.preventDefault();
    };

    const onTouchEnd = () => {
      if (!tracking.current) return;
      tracking.current = false;
      if (pullRef.current >= THRESHOLD) {
        setRefreshing(true);
        // Let the spinner paint before the synchronous reload.
        window.requestAnimationFrame(() => window.location.reload());
      } else {
        setPull(0);
      }
      pullRef.current = 0;
    };

    // Passive:false on move so preventDefault can block the native overscroll.
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, refreshing]);

  if (!enabled || (pull === 0 && !refreshing)) return null;

  const ready = pull >= THRESHOLD;
  // Translate the indicator down with the pull; spin once refreshing.
  const offset = refreshing ? THRESHOLD : pull;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center"
      style={{ transform: `translateY(${offset - 44}px)` }}
    >
      <div className="mt-[max(0.5rem,env(safe-area-inset-top))] flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#0a2014]/95 text-white shadow-lg backdrop-blur">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-5 w-5 ${refreshing ? "animate-spin" : ""}`}
          style={
            refreshing
              ? undefined
              : {
                  transform: `rotate(${Math.min(pull / MAX_PULL, 1) * 270}deg)`,
                }
          }
          aria-hidden="true"
        >
          {refreshing ? (
            // Partial ring while spinning.
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          ) : (
            <>
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </>
          )}
        </svg>
      </div>
      <span className="sr-only">
        {refreshing
          ? "Refreshing"
          : ready
            ? "Release to refresh"
            : "Pull to refresh"}
      </span>
    </div>
  );
}
