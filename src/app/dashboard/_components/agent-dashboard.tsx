"use client";

import { useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { InstallButton } from "~/app/_components/install-button";
import { repoToNamespace } from "~/server/agents/namespace";
import { authClient } from "~/server/better-auth/client";
import { api } from "~/trpc/react";
import { expiresIn, isAgentDone, STATUS_STYLES } from "./agent-ui";
import { DeployModal } from "./deploy-modal";
import { InteractiveSessions } from "./interactive-sessions";
import { LogModal } from "./log-modal";
import {
  primeAudio,
  requestNotificationPermission,
  useAwaitingInputAlerts,
  useCompletionAlerts,
  useNotifyPref,
} from "./notifications";
import { OverviewPanel } from "./overview-panel";
import { RepoConfigModal } from "./repo-config-modal";
import { SearchableSelect, type SelectOption } from "./searchable-select";
import { SettingsModal } from "./settings-modal";

type Repo = {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  namespace: string;
  private: boolean;
  canManageWebhooks: boolean;
};

function VisibilityBadge({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${
        isPrivate
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300/80"
          : "border-green-500/30 bg-green-500/10 text-green-300/80"
      }`}
    >
      {isPrivate ? "Private" : "Public"}
    </span>
  );
}

function RepoSelector({
  repos,
  selected,
  onChange,
  loading,
}: {
  repos: Repo[];
  selected: Repo | null;
  onChange: (fullName: string) => void;
  loading: boolean;
}) {
  const sorted = [...repos].sort((a, b) =>
    a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()),
  );

  const options: SelectOption[] = sorted.map((r) => {
    const [owner, name] = r.fullName.split("/");
    return {
      value: r.fullName,
      searchText: r.fullName.toLowerCase(),
      label: (
        <span className="flex w-full items-center gap-1.5">
          <span className="min-w-0 truncate">
            <span className="text-white/40">{owner}/</span>
            <span className="text-white">{name}</span>
          </span>
          <span className="ml-auto shrink-0">
            <VisibilityBadge isPrivate={r.private} />
          </span>
        </span>
      ),
    };
  });

  return (
    <SearchableSelect
      className="w-80"
      options={options}
      value={selected?.fullName ?? null}
      onChange={(v) => v && onChange(v)}
      placeholder="Select repository"
      loading={loading}
      searchPlaceholder="Search repositories…"
      emptyText="No repositories found. Sign out and back in to grant repo access."
    />
  );
}

export function AgentDashboard({
  user,
  repoSlug,
}: {
  user: { name: string; image?: string | null };
  repoSlug: string | null;
}) {
  const router = useRouter();
  const [logPod, setLogPod] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showWebhooks, setShowWebhooks] = useState(false);

  // The selected repo lives in the URL (repoSlug) so it survives refreshes.
  // Namespace is derived from the slug directly so the agent list can load
  // before the repo list (which carries clone URL / branch) finishes fetching.
  const namespace = repoSlug ? repoToNamespace(repoSlug) : null;

  const { data: repos = [], isLoading: reposLoading } =
    api.repos.list.useQuery();
  const selectedRepo = repoSlug
    ? (repos.find((r) => r.fullName === repoSlug) ?? null)
    : null;
  // Pass the selected repo so a repo's own (preferred) kubeconfig counts as
  // configured — the "Configure kubeconfig" prompt shouldn't render when the
  // repo already resolves a cluster, even if the user hasn't set one.
  const { data: kubeStatus, isLoading: kubeLoading } =
    api.account.kubeconfigStatus.useQuery({
      repoFullName: repoSlug ?? undefined,
    });
  const kubeConfigured = kubeStatus?.configured ?? false;

  const {
    data: agents = [],
    isLoading: agentsLoading,
    error,
    dataUpdatedAt,
  } = api.agents.list.useQuery(
    { namespace: namespace!, repoFullName: repoSlug ?? undefined },
    {
      // A repo may provide its own kubeconfig even when the user hasn't, so
      // allow the query whenever a repo is selected; the server returns a clear
      // error if no cluster resolves at all.
      enabled: !!namespace && (kubeConfigured || !!repoSlug),
      refetchInterval: 5000,
    },
  );

  const terminate = api.agents.terminate.useMutation({
    onSuccess: () => setConfirmKill(null),
  });

  // Interactive agents are pinned above the table; those awaiting input come
  // first so the user sees what needs them at the very top, and finished
  // sessions sink to the bottom.
  const interactiveAgents = agents
    .filter((a) => a.interactive)
    .sort((a, b) => {
      const doneDiff =
        Number(isAgentDone(a.status)) - Number(isAgentDone(b.status));
      if (doneDiff !== 0) return doneDiff;
      return Number(b.awaitingInput) - Number(a.awaitingInput);
    });
  // Non-interactive agents fill the table; completed ones sink to the bottom.
  const tableAgents = agents
    .filter((a) => !a.interactive)
    .sort(
      (a, b) => Number(isAgentDone(a.status)) - Number(isAgentDone(b.status)),
    );

  // Chime + system notification when an agent finishes or starts awaiting input.
  const [notify, setNotify] = useNotifyPref();
  useCompletionAlerts(agents, notify);
  useAwaitingInputAlerts(interactiveAgents, notify);

  async function toggleNotify() {
    if (!notify) {
      primeAudio(); // unlock audio within this user gesture
      await requestNotificationPermission();
    }
    setNotify(!notify);
  }

  function handleRepoChange(fullName: string) {
    setLogPod(null);
    setConfirmKill(null);
    // Navigate to the repo's own URL so the selection persists across refreshes.
    router.push(`/repo/${fullName}`);
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold tracking-tight">
              <Link
                href="/"
                className="flex items-center gap-2.5 transition hover:opacity-80"
              >
                <BandolierIcon className="h-7 w-7 shrink-0" />
                Bandolier
              </Link>
            </h1>

            <RepoSelector
              repos={repos}
              selected={selectedRepo}
              onChange={handleRepoChange}
              loading={reposLoading}
            />

            {/* Repo config (webhooks + agent image) — only when the user can
                manage this repo (admin on GitHub). Kept on the left so toggling
                it doesn't shift the Deploy button. */}
            {selectedRepo?.canManageWebhooks && (
              <button
                onClick={() => setShowWebhooks(true)}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-white/70 hover:bg-white/10 hover:text-white"
              >
                Repo config
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            {namespace && kubeConfigured && (
              <span className="text-xs text-white/30">
                {agentsLoading
                  ? "Refreshing…"
                  : `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`}
              </span>
            )}
            <button
              onClick={() => setShowDeploy(true)}
              disabled={!selectedRepo || !kubeConfigured}
              className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Deploy Agent
            </button>
            <button
              onClick={toggleNotify}
              aria-label={
                notify
                  ? "Disable completion notifications"
                  : "Enable completion notifications"
              }
              title={
                notify
                  ? "Completion alerts on (chime + notification)"
                  : "Completion alerts off"
              }
              className={`rounded-lg p-1.5 hover:bg-white/10 ${
                notify ? "text-purple-300" : "text-white/40 hover:text-white"
              }`}
            >
              {notify ? (
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5"
                >
                  <path d="M10 2a5 5 0 0 0-5 5v2.6c0 .54-.21 1.06-.6 1.45L3 12.5V14h14v-1.5l-1.4-1.45a2.05 2.05 0 0 1-.6-1.45V7a5 5 0 0 0-5-5Zm0 16a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 10 18Z" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5"
                >
                  <path d="M10 2a5 5 0 0 0-5 5v2.6c0 .54-.21 1.06-.6 1.45L3 12.5V14h14v-1.5l-1.4-1.45a2.05 2.05 0 0 1-.6-1.45V7a5 5 0 0 0-5-5Zm0 16a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 10 18Z" />
                  <path
                    d="M3 3l14 14"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              title="Settings"
              className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                <path
                  fillRule="evenodd"
                  d="M8.34 1.94a1.5 1.5 0 0 1 3.32 0l.12.66a1.5 1.5 0 0 0 2.06 1.19l.63-.25a1.5 1.5 0 0 1 1.92 2.05l-.32.6a1.5 1.5 0 0 0 .79 2.16l.64.23a1.5 1.5 0 0 1 0 2.84l-.64.23a1.5 1.5 0 0 0-.79 2.16l.32.6a1.5 1.5 0 0 1-1.92 2.05l-.63-.25a1.5 1.5 0 0 0-2.06 1.19l-.12.66a1.5 1.5 0 0 1-3.32 0l-.12-.66a1.5 1.5 0 0 0-2.06-1.19l-.63.25a1.5 1.5 0 0 1-1.92-2.05l.32-.6a1.5 1.5 0 0 0-.79-2.16l-.64-.23a1.5 1.5 0 0 1 0-2.84l.64-.23a1.5 1.5 0 0 0 .79-2.16l-.32-.6a1.5 1.5 0 0 1 1.92-2.05l.63.25a1.5 1.5 0 0 0 2.06-1.19l.12-.66ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            <div className="flex items-center gap-2 border-l border-white/10 pl-3">
              {user.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.image}
                  alt={user.name}
                  className="h-7 w-7 rounded-full"
                />
              )}
              <span className="text-sm text-white/60">{user.name}</span>
              <button
                onClick={async () => {
                  await authClient.signOut();
                  router.refresh();
                }}
                className="rounded bg-white/10 px-2 py-1 text-xs text-white/60 hover:bg-white/20 hover:text-white"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 space-y-6 px-6 py-6">
        {/* No kubeconfig — prompt to connect a cluster before anything else. */}
        {!kubeLoading && !kubeConfigured && (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-sky-500/20 bg-sky-500/5 py-20 text-center">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-12 w-12 text-sky-300/70"
            >
              <path
                d="M12 2 3 7v6c0 5 3.8 8.3 9 9 5.2-.7 9-4 9-9V7l-9-5Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <div>
              <p className="text-lg font-medium text-white">
                Connect a cluster
              </p>
              <p className="mt-1 text-sm text-white/50">
                Add a kubeconfig to deploy and monitor agents in your cluster.
              </p>
            </div>
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500"
            >
              Configure kubeconfig
            </button>
          </div>
        )}

        {/* No repo selected — show a cross-repo overview of all agents. */}
        {kubeConfigured && !namespace && <OverviewPanel notify={notify} />}

        {kubeConfigured && namespace && (
          <>
            {/* Error banner */}
            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                <span className="font-semibold">Kubernetes error: </span>
                {error.message}
              </div>
            )}

            {/* Interactive sessions, pinned to the top with live logs + input */}
            <InteractiveSessions
              agents={interactiveAgents}
              namespace={namespace}
              repoFullName={repoSlug ?? undefined}
            />

            {/* Agent table (non-interactive agents) */}
            {!error && agents.length === 0 && !agentsLoading ? (
              <div className="rounded-xl border border-white/10 bg-white/5 py-16 text-center text-white/40">
                No agents running in{" "}
                <code className="text-white/60">{namespace}</code>
              </div>
            ) : tableAgents.length === 0 ? null : (
              <div className="overflow-hidden rounded-xl border border-white/10">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium tracking-wider text-white/50 uppercase">
                      {[
                        "Task",
                        "Created by",
                        "Status",
                        "Currently",
                        "Expires",
                        "Output",
                        "",
                      ].map((h) => (
                        <th key={h} className="px-4 py-4 align-top">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {tableAgents.map((agent) => (
                      <tr
                        key={agent.name}
                        onClick={() => setLogPod(agent.name)}
                        className="cursor-pointer hover:bg-white/[0.04]"
                      >
                        <td className="px-4 py-4 align-top">
                          <span className="text-sm text-white/90">
                            {agent.displayName}
                          </span>
                        </td>
                        <td
                          className="px-4 py-4 align-top"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {agent.source === "github-issue" && agent.issueUrl ? (
                            <a
                              href={agent.issueUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-xs text-sky-300 transition hover:bg-sky-500/20"
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
                            <span className="text-xs text-white/50">
                              {agent.createdBy ?? "Dashboard"}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-4 align-top">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[agent.status] ?? STATUS_STYLES.Unknown}`}
                          >
                            {agent.status}
                          </span>
                        </td>
                        <td className="max-w-md px-4 py-4 align-top">
                          <span className="block text-xs break-words text-white/40 italic">
                            {agent.currently ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-4 align-top text-white/50 tabular-nums">
                          {expiresIn(agent.expiresAt)}
                        </td>
                        <td
                          className="px-4 py-4 align-top"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {agent.createdIssueUrl ? (
                            <a
                              href={agent.createdIssueUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 transition hover:bg-emerald-500/20"
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
                        <td
                          className="px-4 py-4 text-right align-top"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {confirmKill === agent.name ? (
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() =>
                                  terminate.mutate({
                                    podName: agent.name,
                                    namespace: namespace,
                                    repoFullName: repoSlug ?? undefined,
                                  })
                                }
                                disabled={terminate.isPending}
                                className="rounded bg-red-600/40 px-2 py-1 text-xs text-red-200 hover:bg-red-600/60 disabled:opacity-50"
                              >
                                {terminate.isPending ? "…" : "Confirm"}
                              </button>
                              <button
                                onClick={() => setConfirmKill(null)}
                                className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmKill(agent.name)}
                              aria-label="Terminate agent"
                              className="rounded p-1 text-red-500/50 hover:bg-red-500/10 hover:text-red-400"
                            >
                              <svg
                                viewBox="0 0 16 16"
                                fill="currentColor"
                                className="h-4 w-4"
                              >
                                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                              </svg>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 px-6 py-4">
        <div className="flex items-center justify-between text-sm text-white/40">
          <span>Bandolier</span>
          <InstallButton />
        </div>
      </footer>

      {logPod && namespace && (
        <LogModal
          podName={logPod}
          namespace={namespace}
          jobName={agents.find((a) => a.name === logPod)?.jobName}
          repoFullName={repoSlug ?? undefined}
          prompt={agents.find((a) => a.name === logPod)?.prompt ?? null}
          onClose={() => setLogPod(null)}
        />
      )}
      {showDeploy && namespace && selectedRepo && (
        <DeployModal
          onClose={() => setShowDeploy(false)}
          namespace={namespace}
          repoFullName={selectedRepo.fullName}
          defaultRepoUrl={selectedRepo.cloneUrl}
          defaultBranch={selectedRepo.defaultBranch}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showWebhooks && selectedRepo?.canManageWebhooks && (
        <RepoConfigModal
          repoFullName={selectedRepo.fullName}
          onClose={() => setShowWebhooks(false)}
        />
      )}
    </div>
  );
}
