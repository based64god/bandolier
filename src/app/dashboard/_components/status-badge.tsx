import { STATUS_ICON_PATHS, STATUS_STYLES, SPINNER_STATUSES } from "./agent-ui";

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
 */
export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.Unknown;
  const iconPath = STATUS_ICON_PATHS[status] ?? STATUS_ICON_PATHS.Unknown;
  const spinning = SPINNER_STATUSES.has(status);

  return (
    <span
      title={status}
      aria-label={status}
      className={`inline-flex items-center justify-center rounded-full border text-xs whitespace-nowrap ${style} px-1.5 py-0.5 md:px-2`}
    >
      {spinning ? (
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
    </span>
  );
}

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
