"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { expiresAtLocal } from "./agent-ui";
import { OutputBadge, SourceBadge } from "./output-badge";
import { StatusBadge } from "./status-badge";

type Task = RouterOutputs["agents"]["list"][number];

/** Column count of the task table — interactive rows span all of them. */
export const TASK_COLUMNS = 7;

/**
 * Columns that remain on narrow viewports — the three secondary columns
 * ("Created by", "Currently", "Expires") are dropped below the `md` breakpoint
 * via `hidden md:table-cell`. An interactive row's expanded body must span only
 * the columns that actually exist at the current breakpoint: a `colSpan` larger
 * than the live column count would conjure phantom columns and re-balance the
 * whole table, shifting every row horizontally when it expands on mobile.
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
  const terminate = api.agents.terminate.useMutation();

  return (
    <tr
      onClick={() => onOpenLogs(agent.name)}
      className="cursor-pointer hover:bg-white/[0.04]"
    >
      <td className="px-3 py-2 text-center align-middle md:px-4 md:py-3">
        {/* Centered to match the centered "Status" header — a flex wrapper
            keeps the pill centered regardless of its (status-dependent) width,
            mirroring the InteractiveRow's status cell. */}
        <div className="flex justify-center">
          <StatusBadge status={agent.status} />
        </div>
      </td>

      <td
        className="px-4 py-2 align-middle md:px-5 md:py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <OutputBadge
          createdIssueUrl={agent.createdIssueUrl}
          createdIssueState={agent.createdIssueState}
          pullRequestUrl={agent.pullRequestUrl}
          pullRequestState={agent.pullRequestState}
        />
      </td>

      <td className="px-3 py-2 align-middle md:px-4 md:py-3">
        {/* Clamped to one line only while the confirm/cancel buttons are
            showing — that's when a long description could bleed past the fixed
            column width into the wider actions alongside it. With just the
            compact terminate (×) control, the full name can use the room. */}
        <span
          title={agent.displayName}
          className={`block text-sm text-white/90 ${confirmKill ? "truncate" : ""}`}
        >
          {agent.displayName}
        </span>
      </td>

      <td
        className="hidden px-3 py-2 align-middle md:table-cell md:px-4 md:py-3"
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
          grow the row height; the full text is available on hover. Dropped on
          narrow viewports where space is limited. */}
      <td className="hidden px-3 py-2 align-middle md:table-cell md:px-4 md:py-3">
        <span
          title={agent.currently ?? undefined}
          className="block max-w-[16rem] truncate text-xs text-white/40 italic"
        >
          {agent.currently ?? "—"}
        </span>
      </td>

      <td className="hidden px-3 py-2 align-middle whitespace-nowrap text-white/50 tabular-nums md:table-cell md:px-4 md:py-3">
        {expiresAtLocal(agent.expiresAt)}
      </td>

      <td
        className="px-3 py-2 text-right align-middle md:px-4 md:py-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* The actions cell reserves the height of the tallest control
            (`ACTION_ROW_MIN_H`) so a row never grows or shrinks vertically as
            its action toggles between the compact terminate (×) glyph and the
            taller confirm/cancel buttons — only an expanding interactive row
            should change a row's height. */}
        <div
          className={`flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap ${ACTION_ROW_MIN_H}`}
        >
          {confirmKill ? (
            <>
              <button
                onClick={() =>
                  terminate.mutate({
                    podName: agent.name,
                    namespace,
                    repoFullName,
                  })
                }
                disabled={terminate.isPending}
                className="rounded bg-red-600/40 px-2 py-1 text-xs text-red-200 hover:bg-red-600/60 disabled:opacity-50"
              >
                {terminate.isPending ? "…" : "Confirm"}
              </button>
              <button
                onClick={() => setConfirmKill(false)}
                className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmKill(true)}
              aria-label="Terminate agent"
              className="rounded p-1 text-red-500/50 hover:bg-red-500/10 hover:text-red-400"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
