import { STATUS_ICON_PATHS, STATUS_STYLES } from "./agent-ui";

/**
 * Status pill for the agent tables. Shows the full status text on wider
 * viewports; on narrow/mobile screens — where horizontal space is at a premium —
 * it collapses to a comparable icon while keeping the colour cue, so the status
 * stays legible without the text widening the row. The full label is always
 * available to assistive tech (and on hover) via the title/aria-label.
 */
export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.Unknown;
  const iconPath = STATUS_ICON_PATHS[status] ?? STATUS_ICON_PATHS.Unknown;

  return (
    <span
      title={status}
      aria-label={status}
      className={`inline-flex items-center justify-center rounded-full border text-xs whitespace-nowrap ${style} px-1.5 py-0.5 md:px-2`}
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        className="h-3.5 w-3.5 md:hidden"
      >
        <path fillRule="evenodd" clipRule="evenodd" d={iconPath} />
      </svg>
      <span className="hidden md:inline">{status}</span>
    </span>
  );
}
