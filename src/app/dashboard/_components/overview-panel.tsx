"use client";

import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";
import { useAwaitingInputAlerts, useCompletionAlerts } from "./notifications";
import { OutputBadge, SourceBadge } from "./output-badge";
import { StatusBadge } from "./status-badge";

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
                { label: "Status", width: "w-[14%]", center: true },
                // Wider on mobile so the output pill (Issue/PR + state glyph)
                // fits its cell; without the extra room the fixed layout
                // starves this column and the badge spills into Repository.
                { label: "Output", width: "w-[28%] md:w-[12%]", center: true },
                { label: "Repository", width: "w-[auto]" },
                // Dropped on narrow viewports where space is limited — the row
                // stays readable with Status/Output/Repository alone.
                { label: "Created by", width: "w-[22%]", optional: true },
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
                    <div className="flex flex-col items-center gap-1">
                      <StatusBadge status={agent.status} />
                      {agent.awaitingInput && (
                        <span className="flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/15 px-2 py-0.5 text-xs font-medium text-amber-200">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                          Waiting for input
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
                    <span className="hidden truncate text-xs text-white/40 md:block">
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
