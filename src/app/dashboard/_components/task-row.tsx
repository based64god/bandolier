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
        <StatusBadge status={agent.status} />
      </td>

      <td
        className="px-3 py-2 align-middle md:px-4 md:py-3"
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
        <span className="text-sm text-white/90">{agent.displayName}</span>
      </td>

      <td
        className="hidden px-3 py-2 align-middle md:px-4 md:py-3 md:table-cell"
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
      <td className="hidden px-3 py-2 align-middle md:px-4 md:py-3 md:table-cell">
        <span
          title={agent.currently ?? undefined}
          className="block max-w-[16rem] truncate text-xs text-white/40 italic"
        >
          {agent.currently ?? "—"}
        </span>
      </td>

      <td className="hidden px-3 py-2 align-middle md:px-4 md:py-3 whitespace-nowrap text-white/50 tabular-nums md:table-cell">
        {expiresAtLocal(agent.expiresAt)}
      </td>

      <td
        className="px-3 py-2 text-right align-middle md:px-4 md:py-3"
        onClick={(e) => e.stopPropagation()}
      >
        {confirmKill ? (
          <span className="flex items-center justify-end gap-1">
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
          </span>
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
      </td>
    </tr>
  );
}
