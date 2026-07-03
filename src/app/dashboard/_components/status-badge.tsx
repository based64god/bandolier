"use client";

import { useEffect, useRef, useState } from "react";

import {
  STATUS_ICON_PATHS,
  STATUS_STYLES,
  SPINNER_STATUSES,
  explainFailure,
  type TaskFailure,
} from "./agent-ui";

/**
 * A small indeterminate spinner — a faint track with a brighter rotating arc —
 * inheriting the pill's text colour. Sits inline with the status label on wide
 * viewports; stands in for the collapsed icon on narrow ones.
 */
function Spinner() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="h-3.5 w-3.5 animate-spin md:mr-1"
    >
      <circle
        cx="10"
        cy="10"
        r="7"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2.5"
      />
      <path
        d="M10 3a7 7 0 0 1 7 7"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BadgeContent({ status }: { status: string }) {
  const iconPath = STATUS_ICON_PATHS[status] ?? STATUS_ICON_PATHS.Unknown;

  return (
    <>
      {SPINNER_STATUSES.has(status) ? (
        <Spinner />
      ) : (
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="h-3.5 w-3.5 md:hidden"
        >
          <path fillRule="evenodd" clipRule="evenodd" d={iconPath} />
        </svg>
      )}
      <span className="hidden md:inline">{status}</span>
    </>
  );
}

/**
 * Tappable variant of the Failed pill. The popover is fixed-positioned and
 * anchored to the badge on open: the tables live inside `overflow-hidden`
 * wrappers, so an absolutely-positioned child would be clipped at the panel
 * edge. It closes on outside tap, Escape, or scroll (scrolling would leave a
 * fixed popover floating away from its badge).
 */
function FailedBadge({
  status,
  failure,
  className,
}: {
  status: string;
  failure: TaskFailure;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e.target instanceof Node &&
        (buttonRef.current?.contains(e.target) ||
          popoverRef.current?.contains(e.target))
      )
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    // Capture phase so scrolls inside nested scroll containers close it too.
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const explanation = explainFailure(failure);

  const toggle = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      // Anchor below the badge, clamped so a 18rem (w-72) card never runs off
      // either viewport edge.
      const width = 288;
      const left = Math.max(
        8,
        Math.min(rect.left, window.innerWidth - width - 8),
      );
      setAnchor({ top: rect.bottom + 6, left });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          // Rows open their logs on click; the badge tap is its own action.
          e.stopPropagation();
          toggle();
        }}
        title={`${status} — ${explanation.title} (tap for details)`}
        aria-label={`${status}: ${explanation.title}. Tap for details.`}
        aria-expanded={open}
        className={`inline-flex cursor-pointer items-center justify-center rounded-full border text-xs whitespace-nowrap underline decoration-dotted underline-offset-2 hover:bg-red-500/30 ${className} px-1.5 py-0.5 md:px-2`}
      >
        <BadgeContent status={status} />
      </button>
      {open && anchor && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Failure details"
          onClick={(e) => e.stopPropagation()}
          style={{ top: anchor.top, left: anchor.left }}
          className="fixed z-50 w-72 rounded-lg border border-red-500/30 bg-neutral-900 p-3 text-left shadow-xl shadow-black/50"
        >
          <p className="text-xs font-semibold text-red-300">
            {explanation.title}
          </p>
          <p className="mt-1 text-xs leading-5 text-white/70">
            {explanation.why}
          </p>
          <p className="mt-2 text-xs leading-5 text-white/50">
            <span className="font-medium text-white/70">Suggested fix: </span>
            {explanation.fix}
          </p>
        </div>
      )}
    </>
  );
}

/**
 * Status pill for the agent tables. Shows the full status text on wider
 * viewports; on narrow/mobile screens — where horizontal space is at a premium —
 * it collapses to a comparable icon while keeping the colour cue, so the status
 * stays legible without the text widening the row. The full label is always
 * available to assistive tech (and on hover) via the title/aria-label.
 *
 * In-flight statuses (see SPINNER_STATUSES — the old blue "Running" pill) render
 * a small animated spinner instead of a static glyph, so activity reads at a
 * glance on every viewport.
 *
 * A Failed pill with failure detail becomes tappable: it opens a small popover
 * explaining why the pod failed (OOM kill, eviction, crash exit code) and what
 * to do about it — the bare phase hides all of that.
 */
export function StatusBadge({
  status,
  failure,
}: {
  status: string;
  failure?: TaskFailure | null;
}) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.Unknown!;

  if (status === "Failed" && failure) {
    return <FailedBadge status={status} failure={failure} className={style} />;
  }

  return (
    <span
      title={status}
      aria-label={status}
      className={`inline-flex items-center justify-center rounded-full border text-xs whitespace-nowrap ${style} px-1.5 py-0.5 md:px-2`}
    >
      <BadgeContent status={status} />
    </span>
  );
}
