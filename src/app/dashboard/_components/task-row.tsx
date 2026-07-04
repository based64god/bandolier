"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { expiresAtLocal, taskNameLabel, taskNameTooltip } from "./agent-ui";
import { OutputBadge, ResumedBadge, SourceBadge } from "./output-badge";
import { StatusBadge } from "./status-badge";
import { TokenReadout } from "./token-readout";

type Task = RouterOutputs["agents"]["list"][number];

/** Column count of the full (xl+) task table — interactive rows span all of them. */
export const TASK_COLUMNS = 7;

/**
 * Column count in the 1024–1279 band, where "Currently" (hidden xl:table-cell)
 * hasn't joined yet but "Created by"/"Expires" (hidden lg:table-cell) have.
 */
export const LG_TASK_COLUMNS = 6;

/**
 * Columns that remain in the compact layout below `lg`. An interactive row's
 * expanded body must span only the columns that actually exist at the current
 * breakpoint: a `colSpan` larger than the live column count would conjure
 * phantom columns and re-balance the whole table, shifting every row
 * horizontally when it expands.
 */
export const MOBILE_TASK_COLUMNS = 4;

/**
 * Fixed height for the "Actions" cell's inner row, shared by TaskRow and
 * InteractiveRow. It matches the tallest action control (the bordered
 * "End session" / confirm buttons) so a collapsed row keeps a constant height
 * no matter which action — terminate glyph, confirm/cancel, end-session, or
 * none — is currently shown. Without it, a row visibly shrinks when its taller
 * control disappears (e.g. once a session ends), shifting every row below it.
 * Only an expanding interactive row should ever change a row's height.
 */
export const ACTION_ROW_MIN_H = "min-h-[1.875rem]";

/**
 * A non-interactive task as a compact row in the task table (matching the
 * overview table's density). Clicking the row opens its logs; cells surface the
 * source (issue link or creator), status, the live "currently" line, expiry, and
 * any PR/issue output, plus a terminate control. Interactive tasks render as an
 * expandable InteractiveCard instead.
 */
export function TaskRow({
  agent,
  namespace,
  repoFullName,
  onOpenLogs,
}: {
  agent: Task;
  namespace: string;
  repoFullName?: string;
  onOpenLogs: (podName: string) => void;
}) {
  const [confirmKill, setConfirmKill] = useState(false);
  const utils = api.useUtils();
  const terminate = api.agents.terminate.useMutation({
    // Refetch the list immediately so the row reflects the deletion as soon as
    // the cluster does; until then the optimistic "Terminating" cue below fills
    // the gap.
    onSuccess: () => utils.agents.list.invalidate({ namespace }),
  });
  // Once terminate is requested the pod lingers in the list (phase Running, now
  // with a deletion timestamp) until Kubernetes actually removes it. Keep the
  // optimistic cue for the whole window — from the click until this row unmounts
  // because the pod is gone — so the user sees their request took effect.
  const terminating = terminate.isPending || terminate.isSuccess;

  return (
    <tr
      onClick={() => onOpenLogs(agent.name)}
      aria-busy={terminating}
      className={`cursor-pointer hover:bg-white/[0.04] ${
        terminating ? "opacity-50" : ""
      }`}
    >
      <td className="px-3 py-2 text-center align-middle md:px-4 md:py-3">
        {/* Centered to match the centered "Status" header — a flex wrapper
            keeps the pill centered regardless of its (status-dependent) width,
            mirroring the InteractiveRow's status cell. */}
        <div className="flex justify-center">
          {terminating ? (
            <StatusBadge status="Terminating" />
          ) : (
            <StatusBadge status={agent.status} failure={agent.failure} />
          )}
        </div>
      </td>

      <td
        className="px-4 py-2 text-center align-middle md:px-5 md:py-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Centered to match the centered "Output" header — a flex wrapper
            keeps the badge (or the empty-state dash) centered regardless of its
            width, mirroring the Status cell. */}
        <div className="flex justify-center">
          <OutputBadge
            createdIssueUrl={agent.createdIssueUrl}
            createdIssueState={agent.createdIssueState}
            pullRequestUrl={agent.pullRequestUrl}
            pullRequestState={agent.pullRequestState}
          />
        </div>
      </td>

      <td className="px-3 py-2 align-middle md:px-4 md:py-3">
        {/* Name clamps to one line so a long description can't grow the row
            taller than its neighbours; the full text is on hover. The lineage
            chip and token readout sit outside the truncating span (and won't
            shrink), so neither gets clipped away by a long name. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <ResumedBadge
            parentJobName={agent.parentJobName}
            parentDisplayName={agent.parentDisplayName}
          />
          <span
            title={taskNameTooltip(agent)}
            className="min-w-0 flex-1 truncate text-sm text-white/90"
          >
            {taskNameLabel(agent)}
          </span>
          <TokenReadout tokens={agent.tokens} className="text-[11px]" />
        </div>
      </td>

      <td
        className="hidden px-3 py-2 align-middle md:px-4 md:py-3 lg:table-cell"
        onClick={(e) => e.stopPropagation()}
      >
        <SourceBadge
          source={agent.source}
          issueUrl={agent.issueUrl}
          issueNumber={agent.issueNumber}
          issueState={agent.issueState}
          createdBy={agent.createdBy}
        />
      </td>

      {/* Live "currently" line — clamped to one line so a long output can't
          grow the row height; the full text is available on hover. Shown only
          from `xl` up: between lg and xl the fixed-width columns leave the Task
          column too little room if this one also takes a share (see the header
          in agent-dashboard). */}
      <td className="hidden px-3 py-2 align-middle md:px-4 md:py-3 xl:table-cell">
        <span
          title={agent.currently ?? undefined}
          className="block max-w-[16rem] truncate text-xs text-white/40 italic"
        >
          {agent.currently ?? "—"}
        </span>
      </td>

      <td className="hidden px-3 py-2 align-middle whitespace-nowrap text-white/50 tabular-nums md:px-4 md:py-3 lg:table-cell">
        {expiresAtLocal(agent.expiresAt)}
      </td>

      <td
        className="px-3 py-2 text-right align-middle md:px-4 md:py-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* The actions cell reserves the height of the tallest control
            (`ACTION_ROW_MIN_H`) so a row never grows or shrinks vertically as
            its action toggles between the compact terminate (×) glyph and the
            confirm/cancel pair — only an expanding interactive row should change
            a row's height. The pair never wraps (`flex-nowrap`, even on mobile):
            a wrapped second line would grow the row on the narrow mobile Actions
            column. To fit that column on one line, Confirm/Cancel collapse to
            compact glyphs below `lg` (see below), showing their full labels from
            `lg` up. */}
        <div
          className={`flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap ${ACTION_ROW_MIN_H}`}
        >
          {terminating ? (
            // Deletion requested — the controls are gone (there's nothing left
            // to confirm) and the status pill carries the "Terminating" cue.
            <span className="text-xs text-white/25">Terminating…</span>
          ) : !agent.ownedByViewer ? (
            // A collaborator's task: viewable (the row opens its logs) but not
            // controllable — terminate stays with the owner, and the server
            // enforces the same.
            <span
              title={`Owned by ${agent.createdBy ?? "another user"}`}
              className="text-xs text-white/25"
            >
              view only
            </span>
          ) : confirmKill ? (
            <>
              {/* Full labels from `lg` up; compact glyphs on mobile so the pair
                  keeps the terminate glyph's footprint and stays on one line
                  within the slim Actions column (mirrors InteractiveRow's
                  "End session"). A wrapped second line would grow the row. */}
              <button
                onClick={() =>
                  terminate.mutate({
                    podName: agent.name,
                    namespace,
                    repoFullName,
                  })
                }
                disabled={terminate.isPending}
                aria-label="Confirm"
                className="flex items-center justify-center rounded bg-red-600/40 p-1 text-xs text-red-200 hover:bg-red-600/60 disabled:opacity-50 lg:px-2 lg:py-1"
              >
                <span className="hidden lg:inline">
                  {terminate.isPending ? "…" : "Confirm"}
                </span>
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                  className="h-5 w-5 lg:hidden"
                >
                  <path d="M6.5 10.086 3.707 7.293a1 1 0 0 0-1.414 1.414l3.5 3.5a1 1 0 0 0 1.414 0l7-7a1 1 0 0 0-1.414-1.414L6.5 10.086Z" />
                </svg>
              </button>
              <button
                onClick={() => setConfirmKill(false)}
                aria-label="Cancel"
                className="flex items-center justify-center rounded bg-white/10 p-1 text-xs hover:bg-white/20 lg:px-2 lg:py-1"
              >
                <span className="hidden lg:inline">Cancel</span>
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                  className="h-5 w-5 lg:hidden"
                >
                  <path d="M6.53 3.47a.75.75 0 0 1 0 1.06L4.81 6.25H10a3.75 3.75 0 0 1 0 7.5H8a.75.75 0 0 1 0-1.5h2a2.25 2.25 0 0 0 0-4.5H4.81l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 0Z" />
                </svg>
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmKill(true)}
              aria-label="Terminate agent"
              className="rounded p-1 text-red-500 hover:bg-red-500/10 hover:text-red-300"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-5 w-5">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * A placeholder row for a task the user just deployed, shown at the top of the
 * table until the real pod surfaces in the cluster's pod list (which the list
 * query only picks up on its next poll). It mirrors TaskRow's column geometry so
 * the columns stay aligned, and carries a spinning "Deploying" pill so the user
 * sees their create request is propagating rather than being lost.
 */
export function PendingDeployRow({ displayName }: { displayName: string }) {
  return (
    <tr aria-busy className="opacity-70">
      <td className="px-3 py-2 text-center align-middle md:px-4 md:py-3">
        <div className="flex justify-center">
          <StatusBadge status="Deploying" />
        </div>
      </td>

      <td className="px-4 py-2 text-center align-middle text-white/30 md:px-5 md:py-3">
        —
      </td>

      <td className="px-3 py-2 align-middle md:px-4 md:py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            title={displayName}
            className="min-w-0 flex-1 truncate text-sm text-white/90"
          >
            {displayName || "New task"}
          </span>
          <span className="shrink-0 text-[11px] text-white/30 italic">
            propagating…
          </span>
        </div>
      </td>

      <td className="hidden px-3 py-2 align-middle text-white/30 md:px-4 md:py-3 lg:table-cell">
        —
      </td>

      <td className="hidden px-3 py-2 align-middle text-white/30 md:px-4 md:py-3 xl:table-cell">
        —
      </td>

      <td className="hidden px-3 py-2 align-middle text-white/30 tabular-nums md:px-4 md:py-3 lg:table-cell">
        —
      </td>

      <td className="px-3 py-2 text-right align-middle md:px-4 md:py-3" />
    </tr>
  );
}
