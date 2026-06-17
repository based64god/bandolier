// Shared PR/issue badges for the agent tables. Each badge links out to GitHub
// and carries a small state indicator (open / closed / merged) when the state is
// known. On mobile the indicator stacks beneath the label to use the row's
// vertical space rather than widening it; on wider viewports it sits inline.

type ItemState = "open" | "closed" | "merged";

// Indicator colours follow GitHub's conventions (open = green, closed = red,
// merged = purple) and stand on their own tint/border so they stay legible even
// inside a same-hued badge (e.g. a merged "PR" pill).
const STATE_CONFIG: Record<ItemState, { label: string; className: string }> = {
  open: {
    label: "Open",
    className: "border-green-400/40 bg-green-400/15 text-green-200",
  },
  closed: {
    label: "Closed",
    className: "border-red-400/40 bg-red-400/15 text-red-200",
  },
  merged: {
    label: "Merged",
    className: "border-purple-300/50 bg-purple-300/20 text-purple-100",
  },
};

/** Small open/closed/merged pill shown alongside a PR or issue badge. */
function StateIndicator({ state }: { state: ItemState }) {
  const cfg = STATE_CONFIG[state];
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 text-[10px] font-semibold tracking-wide uppercase ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

const ISSUE_ICON =
  "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a1 1 0 0 1 1 1v3a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1Zm0 7.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z";
const PR_ICON =
  "M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V5.372ZM5 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6-2.626a2.251 2.251 0 1 0 1.5 0V6.75A3.75 3.75 0 0 0 8.75 3H7.81l.72-.72a.75.75 0 0 0-1.06-1.06L5.22 3.47a.75.75 0 0 0 0 1.06l2.25 2.25a.75.75 0 0 0 1.06-1.06l-.72-.72h.94A2.25 2.25 0 0 1 11 6.75v3.374Zm.75 3.314a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z";

/**
 * A PR/issue badge that links to GitHub and shows its open/closed/merged state.
 * `showIcon` adds the kind glyph (used in the roomier overview table); the
 * compact task rows omit it. The badge is a column on mobile so the state
 * indicator drops onto its own line (vertical space) and a row on `md+`.
 */
function LinkedBadge({
  href,
  label,
  className,
  iconPath,
  state,
  onClick,
}: {
  href: string;
  label: string;
  className: string;
  iconPath?: string;
  state: ItemState | null;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={`inline-flex flex-col items-start gap-1 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition md:flex-row md:items-center md:gap-1.5 ${className}`}
    >
      <span className="inline-flex items-center gap-1.5">
        {iconPath && (
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            className="h-3.5 w-3.5"
          >
            <path d={iconPath} />
          </svg>
        )}
        {label}
      </span>
      {state && <StateIndicator state={state} />}
    </a>
  );
}

/**
 * The "Output" badge for a task: a created issue (emerald) or pull request
 * (purple), each with its open/closed/merged indicator. Renders nothing-but-a
 * dash when the task has produced neither yet.
 */
export function OutputBadge({
  createdIssueUrl,
  createdIssueState,
  pullRequestUrl,
  pullRequestState,
  showIcon = false,
  prLabel = "PR",
}: {
  createdIssueUrl: string | null;
  createdIssueState: ItemState | null;
  pullRequestUrl: string | null;
  pullRequestState: ItemState | null;
  showIcon?: boolean;
  prLabel?: string;
}) {
  if (createdIssueUrl) {
    return (
      <LinkedBadge
        href={createdIssueUrl}
        label="Issue"
        iconPath={showIcon ? ISSUE_ICON : undefined}
        state={createdIssueState}
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
      />
    );
  }
  if (pullRequestUrl) {
    return (
      <LinkedBadge
        href={pullRequestUrl}
        label={prLabel}
        iconPath={showIcon ? PR_ICON : undefined}
        state={pullRequestState}
        className="border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20"
      />
    );
  }
  return <span className="text-xs text-white/20">—</span>;
}

/**
 * The source-issue badge ("Issue #N", sky) shown for issue-triggered tasks, with
 * its open/closed indicator. Falls back to the creator name when the task didn't
 * come from a GitHub issue.
 */
export function SourceBadge({
  source,
  issueUrl,
  issueNumber,
  issueState,
  createdBy,
  onClick,
}: {
  source: string;
  issueUrl: string | null;
  issueNumber: string | null;
  issueState: ItemState | null;
  createdBy: string | null;
  onClick?: (e: React.MouseEvent) => void;
}) {
  if (source === "github-issue" && issueUrl) {
    return (
      <LinkedBadge
        href={issueUrl}
        label={`Issue #${issueNumber}`}
        state={issueState}
        onClick={onClick}
        className="border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
      />
    );
  }
  return (
    <span className="text-xs whitespace-nowrap text-white/50">
      {createdBy ?? "Dashboard"}
    </span>
  );
}
