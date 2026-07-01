// Shared PR/issue badges for the agent tables. Each badge links out to GitHub
// and carries a small state indicator (open / closed / merged) when the state is
// known. The indicator is a compact glyph so it adds state without widening the
// row; it always sits inline next to the label.

type ItemState = "open" | "closed" | "completed" | "merged";

// "closed" carries different meaning for an issue than a PR, so the badge picks
// the glyph from a presentation key rather than the raw state: a closed *issue*
// was closed as not planned (grey circle-slash), but a closed *PR* is one that
// was rejected/abandoned without merging — a failure, shown as a red x. The kind
// the badge renders (`pull` vs `issue`) selects between them.
type PresentationState = ItemState | "closedPull";

// Indicators are icon-only to stay small. Colours follow GitHub's conventions
// (open = green, closed-as-not-planned issue = grey, closed-unmerged PR = blue
// — matching the in-flight spinner, completed = purple, merged = purple) and the
// glyph distinguishes the state so it reads even against a same-hued badge (e.g.
// a merged "PR" pill). An issue closed as *completed* (e.g. resolved by a pull
// request) reads as a success — a purple check-circle — rather than the
// x-circle used for a closed, unmerged pull request.
// Paths are 16×16 GitHub Octicons: a filled dot (open), skip/circle-slash
// (closed as not planned), x-circle (closed-unmerged PR), check-circle
// (completed) and git-merge (merged).
const STATE_CONFIG: Record<
  PresentationState,
  { label: string; className: string; iconPath: string }
> = {
  open: {
    label: "Open",
    className: "text-green-300",
    iconPath: "M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z",
  },
  closed: {
    label: "Closed as not planned",
    className: "text-gray-400",
    iconPath:
      "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM4.92 3.857a6.5 6.5 0 0 0-1.063 1.063l7.223 7.223a6.5 6.5 0 0 0 1.063-1.063L4.92 3.857ZM8 1.5a6.47 6.47 0 0 0-4.08 1.446l8.134 8.134A6.5 6.5 0 0 0 8 1.5Z",
  },
  closedPull: {
    label: "Closed (unmerged)",
    className: "text-blue-300",
    iconPath:
      "M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z",
  },
  completed: {
    label: "Completed",
    className: "text-purple-300",
    iconPath:
      "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.78 5.97a.75.75 0 0 0-1.06 0L7 9.69 5.28 7.97a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.06 0l4.25-4.25a.75.75 0 0 0 0-1.06Z",
  },
  merged: {
    label: "Merged",
    className: "text-purple-300",
    iconPath:
      "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z",
  },
};

/**
 * Small open/closed/merged glyph shown alongside a PR or issue badge. `kind`
 * disambiguates "closed": a closed PR (unmerged) shows the blue x, an issue
 * keeps the grey not-planned circle-slash.
 */
function StateIndicator({
  state,
  kind = "issue",
}: {
  state: ItemState;
  kind?: "pull" | "issue";
}) {
  const key: PresentationState =
    state === "closed" && kind === "pull" ? "closedPull" : state;
  const cfg = STATE_CONFIG[key];
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label={cfg.label}
      className={`h-3.5 w-3.5 shrink-0 ${cfg.className}`}
    >
      <title>{cfg.label}</title>
      <path d={cfg.iconPath} />
    </svg>
  );
}

const ISSUE_ICON =
  "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a1 1 0 0 1 1 1v3a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1Zm0 7.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z";
const PR_ICON =
  "M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V5.372ZM5 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6-2.626a2.251 2.251 0 1 0 1.5 0V6.75A3.75 3.75 0 0 0 8.75 3H7.81l.72-.72a.75.75 0 0 0-1.06-1.06L5.22 3.47a.75.75 0 0 0 0 1.06l2.25 2.25a.75.75 0 0 0 1.06-1.06l-.72-.72h.94A2.25 2.25 0 0 1 11 6.75v3.374Zm.75 3.314a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z";

/**
 * A PR/issue badge that links to GitHub and shows its open/closed/merged state.
 * `showIcon` adds the kind glyph (used in the roomier overview table); the
 * compact task rows omit it. The state indicator is a small inline glyph that
 * trails the label.
 */
function LinkedBadge({
  href,
  label,
  className,
  iconPath,
  state,
  kind,
  onClick,
}: {
  href: string;
  label: string;
  className: string;
  iconPath?: string;
  state: ItemState | null;
  kind?: "pull" | "issue";
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition ${className}`}
    >
      {iconPath && (
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0"
        >
          <path d={iconPath} />
        </svg>
      )}
      {label}
      {state && <StateIndicator state={state} kind={kind} />}
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
        kind="pull"
        className="border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20"
      />
    );
  }
  return <span className="text-xs text-white/20">—</span>;
}

/**
 * Lineage chip for a resumed run ("↻ resumed", amber): a follow-up comment on
 * the parent run's issue or PR spawned this task with the parent's transcript
 * as context. Hovering names the parent run. Renders nothing for normal runs.
 */
export function ResumedBadge({
  parentJobName,
  parentDisplayName,
}: {
  parentJobName: string | null;
  parentDisplayName: string | null;
}) {
  if (!parentJobName) return null;
  return (
    <span
      title={`Resumes ${parentDisplayName ?? parentJobName}`}
      className="inline-flex shrink-0 items-center rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-amber-300"
    >
      ↻ resumed
    </span>
  );
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
