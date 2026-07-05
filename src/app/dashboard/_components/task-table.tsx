"use client";

import type { RouterOutputs } from "~/trpc/react";
import { InteractiveRow } from "./interactive-sessions";
import { PendingDeployRow, TASK_TABLE_COLUMNS, TaskRow } from "./task-row";

type Task = RouterOutputs["agents"]["list"][number];

/**
 * The task list rendered as a fixed-layout table. Just-deployed placeholders sit
 * at the top until their real pod appears; interactive rows owned by the viewer
 * expand in place, everything else opens its logs on click.
 */
export function TaskTable({
  visibleAgents,
  visiblePending,
  namespace,
  repoFullName,
  focusTarget,
  awaitingCount,
  onTableKeyDown,
  onOpenLogs,
}: {
  visibleAgents: Task[];
  visiblePending: { jobName: string; displayName: string }[];
  namespace: string;
  repoFullName: string | undefined;
  focusTarget: { name: string; token: number } | null;
  awaitingCount: number;
  onTableKeyDown: (e: React.KeyboardEvent) => void;
  onOpenLogs: (podName: string) => void;
}) {
  return (
    <div
      onKeyDown={onTableKeyDown}
      className="overflow-hidden rounded-xl border border-white/10"
    >
      {/* table-fixed locks column geometry to the header widths below, so an
          interactive row expanding in place (a full-width colSpan cell with logs
          + input) can only push the rows below it down — it can never re-balance
          the columns the way auto layout did. Percentage widths keep the layout
          responsive and redistribute proportionally when the optional columns
          are hidden on narrow viewports. */}
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium tracking-wider text-white/50 uppercase">
            {TASK_TABLE_COLUMNS.map((h, i) => (
              <th
                key={i}
                className={`px-3 py-2 align-middle md:px-4 md:py-3 ${h.width} ${h.center ? "text-center" : ""} ${h.optional === "lg" ? "hidden lg:table-cell" : ""} ${h.optional === "xl" ? "hidden xl:table-cell" : ""}`}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {/* Just-deployed tasks sit at the very top until their real pod
              appears in the list (then they're pruned). */}
          {visiblePending.map((p) => (
            <PendingDeployRow key={p.jobName} displayName={p.displayName} />
          ))}
          {visibleAgents.map((agent) =>
            agent.interactive && agent.ownedByViewer ? (
              // Interactive sessions are rows too, expanding in place to reveal
              // their live logs + input. Only the owner gets the expanding input
              // row — a collaborator's session renders as a read-only task row
              // (logs viewable, no input).
              <InteractiveRow
                key={agent.name}
                agent={agent}
                namespace={namespace}
                repoFullName={repoFullName}
                focusSignal={
                  focusTarget?.name === agent.name ? focusTarget.token : null
                }
                awaitingCount={awaitingCount}
              />
            ) : (
              <TaskRow
                key={agent.name}
                agent={agent}
                namespace={namespace}
                repoFullName={repoFullName}
                onOpenLogs={onOpenLogs}
              />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
