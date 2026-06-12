"use client";

import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";
import { STATUS_STYLES } from "./agent-ui";
import { useAwaitingInputAlerts, useCompletionAlerts } from "./notifications";

// Active agents float to the top; finished ones sort by soonest expiry.
const STATUS_RANK: Record<string, number> = {
  Running: 0,
  Pending: 1,
  Unknown: 2,
  Failed: 3,
  Succeeded: 4,
};

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
    const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (rank !== 0) return rank;
    return (a.repoFullName ?? "").localeCompare(b.repoFullName ?? "");
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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium tracking-wider text-white/50 uppercase">
              {["Repository", "Task", "Created by", "Status", "Output"].map(
                (h) => (
                  <th key={h} className="px-4 py-4 align-top">
                    {h}
                  </th>
                ),
              )}
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
                  <td className="px-4 py-4 align-top">
                    {repo ? (
                      <span className="text-sm whitespace-nowrap">
                        <span className="text-white/40">{owner}/</span>
                        <span className="text-white/90">{name}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-white/30 italic">
                        No repository
                      </span>
                    )}
                  </td>
                  <td className="max-w-md px-4 py-4 align-top">
                    <span className="block text-sm break-words text-white/90">
                      {agent.displayName}
                    </span>
                  </td>
                  <td className="px-4 py-4 align-top">
                    {agent.source === "github-issue" && agent.issueUrl ? (
                      <a
                        href={agent.issueUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-xs text-sky-300 transition hover:bg-sky-500/20"
                      >
                        Issue #{agent.issueNumber}
                      </a>
                    ) : (
                      <span className="text-xs text-white/50">
                        {agent.createdBy ?? "Dashboard"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4 align-top">
                    <div className="flex flex-col items-start gap-1">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[agent.status] ?? STATUS_STYLES.Unknown}`}
                      >
                        {agent.status}
                      </span>
                      {agent.awaitingInput && (
                        <span className="flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/15 px-2 py-0.5 text-xs font-medium text-amber-200">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                          Waiting for input
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    className="px-4 py-4 align-top"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {agent.pullRequestUrl ? (
                      <a
                        href={agent.pullRequestUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-md border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-xs text-purple-300 transition hover:bg-purple-500/20"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="h-3.5 w-3.5"
                        >
                          <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V5.372ZM5 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6-2.626a2.251 2.251 0 1 0 1.5 0V6.75A3.75 3.75 0 0 0 8.75 3H7.81l.72-.72a.75.75 0 0 0-1.06-1.06L5.22 3.47a.75.75 0 0 0 0 1.06l2.25 2.25a.75.75 0 0 0 1.06-1.06l-.72-.72h.94A2.25 2.25 0 0 1 11 6.75v3.374Zm.75 3.314a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
                        </svg>
                        Pull request
                      </a>
                    ) : (
                      <span className="text-xs text-white/20">—</span>
                    )}
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
