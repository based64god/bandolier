"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { expiresIn, STATUS_STYLES } from "./agent-ui";

type Task = RouterOutputs["agents"]["list"][number];

/** Column count of the task table — interactive rows span all of them. */
export const TASK_COLUMNS = 7;

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
      <td className="px-4 py-3 align-top">
        <span
          className={`rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_STYLES[agent.status] ?? STATUS_STYLES.Unknown}`}
        >
          {agent.status}
        </span>
      </td>

      <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
        {agent.createdIssueUrl ? (
          <a
            href={agent.createdIssueUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 transition hover:bg-emerald-500/20"
          >
            Issue
          </a>
        ) : agent.pullRequestUrl ? (
          <a
            href={agent.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-xs text-purple-300 transition hover:bg-purple-500/20"
          >
            PR
          </a>
        ) : (
          <span className="text-xs text-white/20">—</span>
        )}
      </td>

      <td className="px-4 py-3 align-top">
        <span className="text-sm text-white/90">{agent.displayName}</span>
      </td>

      <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
        {agent.source === "github-issue" && agent.issueUrl ? (
          <a
            href={agent.issueUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-xs whitespace-nowrap text-sky-300 transition hover:bg-sky-500/20"
          >
            Issue #{agent.issueNumber}
          </a>
        ) : (
          <span className="text-xs whitespace-nowrap text-white/50">
            {agent.createdBy ?? "Dashboard"}
          </span>
        )}
      </td>

      {/* Live "currently" line — clamped to one line so a long output can't
          grow the row height; the full text is available on hover. */}
      <td className="px-4 py-3 align-top">
        <span
          title={agent.currently ?? undefined}
          className="block max-w-[16rem] truncate text-xs text-white/40 italic"
        >
          {agent.currently ?? "—"}
        </span>
      </td>

      <td className="px-4 py-3 align-top whitespace-nowrap text-white/50 tabular-nums">
        {expiresIn(agent.expiresAt)}
      </td>

      <td
        className="px-4 py-3 text-right align-top"
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
