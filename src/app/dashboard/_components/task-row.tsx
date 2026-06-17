"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { expiresIn, STATUS_STYLES } from "./agent-ui";

type Task = RouterOutputs["agents"]["list"][number];

/**
 * A non-interactive task as a row in the unified task list. Clicking the row
 * opens its logs; the row also surfaces status, the live "currently" line, the
 * source (issue link or creator), any PR/issue output, expiry, and a terminate
 * control. Interactive tasks use InteractiveCard instead (they expand in place).
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
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
      <div
        onClick={() => onOpenLogs(agent.name)}
        className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 hover:bg-white/[0.04]"
      >
        {/* Identity + live status */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm text-white/90">
            {agent.displayName}
          </span>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[agent.status] ?? STATUS_STYLES.Unknown}`}
          >
            {agent.status}
          </span>
          {agent.currently && (
            <span className="hidden min-w-0 truncate text-xs text-white/40 italic sm:block">
              {agent.currently}
            </span>
          )}
        </div>

        {/* Metadata + actions — stop row-click propagation so links/buttons work. */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex shrink-0 items-center gap-2 text-xs"
        >
          {agent.source === "github-issue" && agent.issueUrl ? (
            <a
              href={agent.issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-300 transition hover:bg-sky-500/20"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-3.5 w-3.5"
              >
                <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a1 1 0 0 1 1 1v3a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1Zm0 7.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
              </svg>
              Issue #{agent.issueNumber}
            </a>
          ) : (
            <span className="hidden text-white/50 md:inline">
              {agent.createdBy ?? "Dashboard"}
            </span>
          )}

          {agent.createdIssueUrl ? (
            <a
              href={agent.createdIssueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300 transition hover:bg-emerald-500/20"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-3.5 w-3.5"
              >
                <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a1 1 0 0 1 1 1v3a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1Zm0 7.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
              </svg>
              Issue
            </a>
          ) : agent.pullRequestUrl ? (
            <a
              href={agent.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-purple-300 transition hover:bg-purple-500/20"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-3.5 w-3.5"
              >
                <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V5.372ZM5 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6-2.626a2.251 2.251 0 1 0 1.5 0V6.75A3.75 3.75 0 0 0 8.75 3H7.81l.72-.72a.75.75 0 0 0-1.06-1.06L5.22 3.47a.75.75 0 0 0 0 1.06l2.25 2.25a.75.75 0 0 0 1.06-1.06l-.72-.72h.94A2.25 2.25 0 0 1 11 6.75v3.374Zm.75 3.314a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
              </svg>
              PR
            </a>
          ) : null}

          <span className="text-white/50 tabular-nums">
            {expiresIn(agent.expiresAt)}
          </span>

          {confirmKill ? (
            <span className="flex items-center gap-1">
              <button
                onClick={() =>
                  terminate.mutate({
                    podName: agent.name,
                    namespace,
                    repoFullName,
                  })
                }
                disabled={terminate.isPending}
                className="rounded bg-red-600/40 px-2 py-1 text-red-200 hover:bg-red-600/60 disabled:opacity-50"
              >
                {terminate.isPending ? "…" : "Confirm"}
              </button>
              <button
                onClick={() => setConfirmKill(false)}
                className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
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
        </div>
      </div>
    </div>
  );
}
