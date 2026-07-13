"use client";

import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";
import { useAwaitingInputAlerts, useCompletionAlerts } from "./notifications";
import { OutputBadge, ResumedBadge, SourceBadge } from "./output-badge";
import { StatusBadge } from "./status-badge";
import { ACTION_ROW_MIN_H } from "./task-row";

/**
 * Home-screen panel listing agents across every repository the user can access.
 * The server enforces permissions; this just renders and links each agent to its
 * repo view. `notify` drives the completion chime/notification here too, so the
 * home screen alerts even when no specific repo is selected.
 */
export function OverviewPanel({ notify }: { notify: boolean }) {
  const router = useRouter();
  const {
    data: agents = [],
    isLoading,
    error,
  } = api.agents.overview.useQuery(undefined, { refetchInterval: 5000 });

  useCompletionAlerts(agents, notify);
  useAwaitingInputAlerts(
    agents.filter((a) => a.interactive),
    notify,
  );

  const sorted = [...agents].sort((a, b) => {
    // Agents waiting on the user float to the very top, wherever they live.
    if (a.awaitingInput !== b.awaitingInput) return a.awaitingInput ? -1 : 1;
    // Then newest-first, matching the per-repo task view.
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });

  const activeCount = agents.filter(
    (a) => a.status === "Running" || a.status === "Pending",
  ).length;
  const repoCount = new Set(
    agents.map((a) => a.repoFullName).filter((r): r is string => r !== null),
  ).size;

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
        <span className="font-semibold">Kubernetes error: </span>
        {error.message}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 py-20 text-center text-white/40">
        Loading agents…
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 py-20 text-center">
        <p className="text-white/60">
          No agents running across your repositories.
        </p>
        <p className="mt-1 text-sm text-white/40">
          Select a repository above to deploy one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-white/70 uppercase">
          All agents
        </h2>
        <span className="text-xs text-white/40">
          {activeCount} active · {agents.length} total
          {repoCount > 0 &&
            ` across ${repoCount} ${repoCount === 1 ? "repository" : "repositories"}`}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10">
        {/* Mirrors the per-repo task list's layout (Status/Output first, a
            compact density, optional columns dropped on narrow viewports). The
            one departure: the repository that owns the task takes priority over
            the task description — it's the primary column, with the task name as
            a muted second line that's dropped on mobile, where the repo alone
            stands in for the task. */}
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium tracking-wider text-white/50 uppercase">
              {[
                // Wider on mobile (like Output below) so the "STATUS" header
                // word fits its cell. Under table-fixed a too-narrow column
                // can't shrink the unbreakable word, so it overflows to the
                // right and the centered badges read as left-of-header; the
                // extra width lets text-center actually center the label over
                // the badges. From `md` up the column is fixed to its widest
                // pill ("Terminating" + padding) — the pill doesn't grow with
                // the viewport, so a percentage share both starved it at 768px
                // and wasted width at 1920px that belongs to Repository.
                // Shares the same widths as the task table (agent-dashboard).
                {
                  label: "Status",
                  width: "w-[18%] md:w-[7.5rem]",
                  center: true,
                },
                // Wider on mobile so the output pill (Issue/PR + state glyph)
                // fits its cell; without the extra room the fixed layout
                // starves this column and the badge spills into Repository.
                // Fixed to the widest badge ("Issue ⏺") from `md` up, like
                // Status. Shares the same widths as the task table.
                { label: "Output", width: "w-[23%] md:w-[7rem]", center: true },
                { label: "Repository", width: "w-[auto]" },
                // Dropped on narrow viewports where space is limited — the row
                // stays readable with Status/Output/Repository alone. Fixed to
                // the "Issue #12345" source badge; long usernames truncate
                // (see SourceBadge).
                { label: "Created by", width: "w-36", optional: true },
              ].map((h, i) => (
                <th
                  key={i}
                  className={`px-3 py-2 align-middle md:px-4 md:py-3 ${h.width} ${h.center ? "text-center" : ""} ${h.optional ? "hidden md:table-cell" : ""}`}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {sorted.map((agent) => {
              const repo = agent.repoFullName;
              const [owner, name] = repo ? repo.split("/") : [null, null];
              return (
                <tr
                  key={`${agent.namespace}/${agent.name}`}
                  onClick={
                    repo ? () => router.push(`/repo/${repo}`) : undefined
                  }
                  className={
                    repo ? "cursor-pointer hover:bg-white/[0.04]" : undefined
                  }
                >
                  <td className="px-3 py-2 text-center align-middle md:px-4 md:py-3">
                    {/* Reserve the same row height as the per-repo task table
                        (`ACTION_ROW_MIN_H`, set there by the Actions cell) so the
                        overview's rows aren't shorter — the task table's floor
                        comes from its action controls, which the overview lacks. */}
                    <div
                      className={`flex flex-col items-center justify-center gap-1 ${ACTION_ROW_MIN_H}`}
                    >
                      <StatusBadge
                        status={agent.status}
                        failure={agent.failure}
                      />
                      {agent.awaitingInput && (
                        <span
                          title="Waiting"
                          aria-label="Waiting"
                          className="flex items-center justify-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/15 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-amber-200 md:px-2"
                        >
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                          <span className="hidden md:inline">Waiting</span>
                        </span>
                      )}
                    </div>
                  </td>

                  <td
                    className="px-3 py-2 text-center align-middle md:px-4 md:py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <OutputBadge
                      createdIssueUrl={agent.createdIssueUrl}
                      createdIssueState={agent.createdIssueState}
                      pullRequestUrl={agent.pullRequestUrl}
                      pullRequestState={agent.pullRequestState}
                    />
                  </td>

                  {/* The owning repository leads here, with the task name as a
                      muted second line. On mobile the task line is dropped, so
                      the repo stands in for the task. */}
                  <td className="px-3 py-2 align-middle md:px-4 md:py-3">
                    {repo ? (
                      <span className="block truncate text-sm whitespace-nowrap">
                        <span className="text-white/40">{owner}/</span>
                        <span className="text-white/90">{name}</span>
                      </span>
                    ) : (
                      <span className="block truncate text-xs text-white/30 italic">
                        No repository
                      </span>
                    )}
                    <span className="hidden items-center gap-1.5 text-xs text-white/40 md:flex">
                      <ResumedBadge
                        parentJobName={agent.parentJobName}
                        parentDisplayName={agent.parentDisplayName}
                      />
                      <span className="min-w-0 truncate">
                        {agent.displayName}
                      </span>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
