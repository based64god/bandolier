"use client";

import { useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { InstallButton } from "~/app/_components/install-button";
import { repoToNamespace } from "~/server/agents/namespace";
import { authClient } from "~/server/better-auth/client";
import { api } from "~/trpc/react";
import { isAgentResolved, nextAwaitingTarget } from "./agent-ui";
import { DashboardHeader } from "./dashboard-header";
import { DeployModal } from "./deploy-modal";
import { useHideResolved, useOnlyMine } from "./view-prefs";
import { LogModal } from "./log-modal";
import {
  primeAudio,
  requestNotificationPermission,
  useAwaitingInputAlerts,
  useBackgroundPush,
  useChimeUnlock,
  useCompletionAlerts,
  useNotifyPref,
} from "./notifications";
import { OverviewPanel } from "./overview-panel";
import { recordRecentRepo } from "./recent-repos";
import { TaskTable, TaskTableSkeleton } from "./task-table";

export function AgentDashboard({
  user,
  repoSlug,
}: {
  user: { name: string; image?: string | null };
  repoSlug: string | null;
}) {
  const router = useRouter();
  const [logPod, setLogPod] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);

  // The selected repo lives in the URL (repoSlug) so it survives refreshes.
  // Namespace is derived from the slug directly so the agent list can load
  // before the repo list (which carries clone URL / branch) finishes fetching.
  const namespace = repoSlug ? repoToNamespace(repoSlug) : null;

  const { data: repos = [], isLoading: reposLoading } =
    api.repos.list.useQuery();
  const selectedRepo = repoSlug
    ? (repos.find((r) => r.fullName === repoSlug) ?? null)
    : null;

  // Record a visit once the URL's repo resolves against the fetched repo list
  // (so direct links count, but bogus slugs never enter the recent list).
  const selectedFullName = selectedRepo?.fullName;
  useEffect(() => {
    if (selectedFullName) recordRecentRepo(selectedFullName);
  }, [selectedFullName]);
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

  // Optimistic placeholders for tasks the user just deployed. Kubernetes creates
  // the Job immediately, but its pod only shows up in the list query on a later
  // poll — so without these the dashboard looks unchanged for several seconds
  // after a deploy. The raw list only grows here (plus a timeout backstop); which
  // ones are actually shown is derived below, so a placeholder disappears the
  // instant its real task lands without any effect-driven state juggling.
  const [pendingDeploys, setPendingDeploys] = useState<
    { jobName: string; displayName: string; namespace: string }[]
  >([]);

  function handleDeployed(task: { jobName: string; displayName: string }) {
    if (!namespace) return;
    const entry = { ...task, namespace };
    setPendingDeploys((prev) => [
      entry,
      ...prev.filter((p) => p.jobName !== task.jobName),
    ]);
    // Backstop: drop the placeholder if the pod never surfaces (e.g. the Job was
    // created but scheduling failed), so it can't linger forever.
    window.setTimeout(() => {
      setPendingDeploys((prev) =>
        prev.filter((p) => p.jobName !== task.jobName),
      );
    }, 90_000);
  }

  // View filters persist in cookies so they survive refreshes, apply across
  // repos, and are not carried into shared links (a shared URL shows the
  // recipient their own preference, not the sender's filtered view).
  const [hideResolved, setHideResolved] = useHideResolved();
  const [onlyMine, setOnlyMine] = useOnlyMine();

  function toggleHideResolved() {
    setHideResolved(!hideResolved);
  }

  // One contiguous list. Tasks awaiting input float to the top regardless of
  // age (they need the user now); the rest follow newest-first. Interactive
  // tasks render as expandable cards (unchanged behaviour); the rest as rows.
  // "Hide resolved" drops tasks that are done with: output has reached a
  // terminal state on GitHub (a merged/closed PR or a closed/completed issue),
  // or the task succeeded and has since expired. "Only my tasks" drops
  // collaborators' tasks (repo views list the whole repo's).
  const sortedAgents = [...agents].sort((a, b) => {
    const awaitDiff = Number(b.awaitingInput) - Number(a.awaitingInput);
    if (awaitDiff !== 0) return awaitDiff;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
  const visibleAgents = sortedAgents.filter(
    (a) =>
      (!hideResolved || !isAgentResolved(a)) && (!onlyMine || a.ownedByViewer),
  );

  // The placeholders to actually render: only for the repo currently in view,
  // and only while the real pod hasn't yet surfaced in the list (matched by job
  // name). Derived rather than stored, so it self-corrects on every poll.
  const liveJobNames = new Set(agents.map((a) => a.jobName));
  const visiblePending = pendingDeploys.filter(
    (p) => p.namespace === namespace && !liveJobNames.has(p.jobName),
  );

  // The viewer's own tasks. Repo views also list collaborators' tasks
  // (read-only) — those must not drive this user's alerts or input focus.
  const ownAgents = agents.filter((a) => a.ownedByViewer);

  // Interactive agents still drive the awaiting-input alerts (own only — a
  // collaborator's session waits for *their* input, not the viewer's).
  const interactiveAgents = ownAgents.filter((a) => a.interactive);

  // Tab-to-cycle: the names of the sessions currently awaiting input, in the
  // order they appear in the table (awaiting tasks already float to the top).
  // Pressing Tab while focus is anywhere in the task table jumps to the next
  // one — expanding it and dropping the cursor into its message box.
  const awaitingNames = visibleAgents
    // Only the viewer's own sessions take input; collaborators' rows are
    // read-only and can't be focus targets.
    .filter((a) => a.awaitingInput && a.ownedByViewer)
    .map((a) => a.name);
  // The session Tab last targeted, plus a monotonic token. The token (re)bumps
  // even when the same session is re-targeted so the row's focus effect always
  // re-fires; the name routes the signal to the right row.
  const [focusTarget, setFocusTarget] = useState<{
    name: string;
    token: number;
  } | null>(null);

  function cycleAwaiting(direction: 1 | -1): boolean {
    const next = nextAwaitingTarget(
      awaitingNames,
      focusTarget?.name ?? null,
      direction,
    );
    if (!next) return false;
    setFocusTarget((prev) => ({ name: next, token: (prev?.token ?? 0) + 1 }));
    return true;
  }

  function handleTableKeyDown(e: React.KeyboardEvent) {
    // Tab / Shift+Tab cycle forward / backward through the awaiting sessions;
    // the other modifier combos are left to the browser's normal focus
    // traversal. When no session is waiting, fall through to default tabbing
    // too (nothing to cycle).
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    if (cycleAwaiting(e.shiftKey ? -1 : 1)) e.preventDefault();
  }

  // Chime + system notification when an agent finishes or starts awaiting input.
  const [notify, setNotify] = useNotifyPref();
  // Re-arm the audio unlock on each visit where notifications are already on
  // (the toggle gesture only primes the session it's clicked in).
  useChimeUnlock(notify);
  useCompletionAlerts(ownAgents, notify);
  useAwaitingInputAlerts(interactiveAgents, notify);
  // Keep the background push subscription in lockstep with the preference so
  // completions notify even with the app closed.
  useBackgroundPush(notify);

  async function toggleNotify() {
    if (!notify) {
      primeAudio(); // unlock audio within this user gesture
      await requestNotificationPermission();
    }
    setNotify(!notify);
  }

  function handleRepoChange(fullName: string) {
    setLogPod(null);
    // Navigate to the repo's own URL so the selection persists across refreshes.
    router.push(`/repo/${fullName}`);
  }

  async function handleSignOut() {
    await authClient.signOut();
    router.refresh();
  }

  // The task the log modal is showing — resolved once rather than re-searched
  // for every prop it feeds.
  const logAgent = logPod
    ? (agents.find((a) => a.name === logPod) ?? null)
    : null;

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      <DashboardHeader
        user={user}
        repos={repos}
        selectedRepo={selectedRepo}
        reposLoading={reposLoading}
        namespace={namespace}
        kubeConfigured={kubeConfigured}
        agentsLoading={agentsLoading}
        dataUpdatedAt={dataUpdatedAt}
        notify={notify}
        onRepoChange={handleRepoChange}
        onToggleNotify={() => void toggleNotify()}
        onDeploy={() => setShowDeploy(true)}
        onShowSettings={() => router.push("/settings")}
        onShowRepoConfig={() => {
          if (selectedRepo)
            router.push(`/repo/${selectedRepo.fullName}/settings`);
        }}
        onSignOut={handleSignOut}
      />

      <main className="flex-1 space-y-6 px-4 py-4 sm:px-6 sm:py-6">
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
                Deploy a cluster with one click — or paste a kubeconfig for one
                you already have — to run and monitor agents.
              </p>
            </div>
            <button
              onClick={() => router.push("/settings#cluster-deploy")}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-black hover:bg-sky-500"
            >
              Set up a cluster
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

            {/* Single contiguous task list — newest first. Interactive tasks
                expand in place; the rest open their logs on click. */}
            {!error &&
            agents.length === 0 &&
            visiblePending.length === 0 &&
            !agentsLoading ? (
              <div className="rounded-xl border border-white/10 bg-white/5 py-16 text-center text-white/40">
                No agents running in{" "}
                <code className="text-white/60">{namespace}</code>
              </div>
            ) : agents.length === 0 && visiblePending.length === 0 ? (
              // First fetch still in flight (the empty+error case renders the
              // banner above and nothing else). The list query round-trips to
              // the cluster and can take a while — show a skeleton so the task
              // area doesn't sit blank.
              !error && <TaskTableSkeleton />
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-2 text-xs font-medium tracking-wider text-white/40 uppercase">
                    Tasks
                    <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-white/50">
                      {visibleAgents.length + visiblePending.length}
                    </span>
                  </h2>
                  <div className="flex items-center gap-4">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-white/50 select-none hover:text-white/70">
                      <input
                        type="checkbox"
                        checked={onlyMine}
                        onChange={() => setOnlyMine(!onlyMine)}
                        className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-purple-500"
                      />
                      Only my tasks
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-white/50 select-none hover:text-white/70">
                      <input
                        type="checkbox"
                        checked={hideResolved}
                        onChange={toggleHideResolved}
                        className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-purple-500"
                      />
                      Hide resolved
                    </label>
                  </div>
                </div>

                {visibleAgents.length === 0 && visiblePending.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-white/5 py-12 text-center text-sm text-white/40">
                    No tasks match the current filters.{" "}
                    <button
                      onClick={() => {
                        setHideResolved(false);
                        setOnlyMine(false);
                      }}
                      className="text-white/70 underline hover:text-white"
                    >
                      Show all tasks
                    </button>
                  </div>
                ) : (
                  <TaskTable
                    visibleAgents={visibleAgents}
                    visiblePending={visiblePending}
                    namespace={namespace}
                    repoFullName={repoSlug ?? undefined}
                    focusTarget={focusTarget}
                    awaitingCount={awaitingNames.length}
                    onTableKeyDown={handleTableKeyDown}
                    onOpenLogs={setLogPod}
                  />
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 px-6 py-4">
        <div className="flex items-center justify-center gap-6 text-sm text-white/40">
          <a
            href="https://github.com/based64god/bandolier"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 transition hover:text-white/70"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              className="h-4 w-4"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            <span>Bandolier on GitHub</span>
          </a>
          <InstallButton />
        </div>
      </footer>

      {logPod && namespace && (
        <LogModal
          podName={logPod}
          namespace={namespace}
          jobName={logAgent?.jobName}
          repoFullName={repoSlug ?? undefined}
          prompt={logAgent?.prompt ?? null}
          tokens={logAgent?.tokens ?? null}
          onClose={() => setLogPod(null)}
        />
      )}
      {showDeploy && namespace && selectedRepo && (
        <DeployModal
          onClose={() => setShowDeploy(false)}
          onDeployed={handleDeployed}
          namespace={namespace}
          repoFullName={selectedRepo.fullName}
          defaultRepoUrl={selectedRepo.cloneUrl}
          defaultBranch={selectedRepo.defaultBranch}
        />
      )}
    </div>
  );
}
