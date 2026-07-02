"use client";

import { useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { InstallButton } from "~/app/_components/install-button";
import { repoToNamespace } from "~/server/agents/namespace";
import { authClient } from "~/server/better-auth/client";
import { api } from "~/trpc/react";
import { isAgentOutputResolved, nextAwaitingTarget } from "./agent-ui";
import { DeployModal } from "./deploy-modal";
import { useHideResolved, useOnlyMine } from "./view-prefs";
import { InteractiveRow } from "./interactive-sessions";
import { LogModal } from "./log-modal";
import {
  primeAudio,
  requestNotificationPermission,
  useAwaitingInputAlerts,
  useChimeUnlock,
  useCompletionAlerts,
  useNotifyPref,
} from "./notifications";
import { OverviewPanel } from "./overview-panel";
import { RepoConfigModal } from "./repo-config-modal";
import { SearchableSelect, type SelectOption } from "./searchable-select";
import { SettingsModal } from "./settings-modal";
import { TaskRow } from "./task-row";

type Repo = {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  namespace: string;
  private: boolean;
  isAdmin: boolean;
};

function VisibilityBadge({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium tracking-wide uppercase ${
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
        // `@container` makes the children respond to the dropdown's own width.
        // As it narrows we drop the owner first (`@max-[220px]`), then the
        // visibility badge (`@max-[150px]`); the repo name always stays (it
        // truncates rather than disappearing).
        <span className="@container flex w-full items-center gap-1.5">
          <span className="min-w-0 truncate">
            <span className="text-white/40 @max-[220px]:hidden">{owner}/</span>
            <span className="text-white">{name}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center @max-[150px]:hidden">
            <VisibilityBadge isPrivate={r.private} />
          </span>
        </span>
      ),
    };
  });

  return (
    <SearchableSelect
      className="min-w-0 flex-1 2xl:w-80 2xl:flex-initial"
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
  const [showDeploy, setShowDeploy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRepoConfig, setShowRepoConfig] = useState(false);
  // Mobile-only: the secondary header controls collapse into this menu so the
  // bar stays within the viewport on narrow screens.
  const [menuOpen, setMenuOpen] = useState(false);

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
  // "Hide resolved" drops tasks whose output has reached a terminal state on
  // GitHub — a merged/closed PR or a closed/completed issue. "Only my tasks"
  // drops collaborators' tasks (repo views list the whole repo's).
  const sortedAgents = [...agents].sort((a, b) => {
    const awaitDiff = Number(b.awaitingInput) - Number(a.awaitingInput);
    if (awaitDiff !== 0) return awaitDiff;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
  const visibleAgents = sortedAgents.filter(
    (a) =>
      (!hideResolved || !isAgentOutputResolved(a)) &&
      (!onlyMine || a.ownedByViewer),
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

  function cycleAwaiting(): boolean {
    const next = nextAwaitingTarget(awaitingNames, focusTarget?.name ?? null);
    if (!next) return false;
    setFocusTarget((prev) => ({ name: next, token: (prev?.token ?? 0) + 1 }));
    return true;
  }

  function handleTableKeyDown(e: React.KeyboardEvent) {
    // Plain Tab only — leave Shift+Tab and the modifier combos to the browser's
    // normal focus traversal. When no session is waiting, fall through to
    // default tabbing too (nothing to cycle).
    if (e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    if (cycleAwaiting()) e.preventDefault();
  }

  // Chime + system notification when an agent finishes or starts awaiting input.
  const [notify, setNotify] = useNotifyPref();
  // Re-arm the audio unlock on each visit where notifications are already on
  // (the toggle gesture only primes the session it's clicked in).
  useChimeUnlock(notify);
  useCompletionAlerts(ownAgents, notify);
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
    // Navigate to the repo's own URL so the selection persists across refreshes.
    router.push(`/repo/${fullName}`);
  }

  // Deploy is the primary action. It renders in the right-hand group on small
  // screens (thumb-friendly for phones) but moves to the horizontal centre of
  // the bar on large viewports, where a centred target better matches how
  // people drive a desktop. The button markup is shared between both slots.
  //
  // It only has any meaning once a repo is selected and a kubeconfig is
  // present, so rather than showing a greyed-out, unclickable button we omit it
  // entirely until both are true. `null` here collapses both slots cleanly.
  const deployButton =
    selectedRepo && kubeConfigured ? (
      <button
        onClick={() => setShowDeploy(true)}
        className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-black hover:bg-purple-500"
      >
        +<span className="hidden sm:inline"> Deploy Agent</span>
      </button>
    ) : null;

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      {/* Header */}
      <header className="border-b border-white/10 px-4 py-3 sm:px-6 sm:py-4">
        {/* A single row at every width. Below xl: the bar is deliberately spare
            — a hamburger (far left) holding the secondary controls, the repo
            selector stretching to fill the middle, and Deploy on the right — so
            the selector keeps a genuinely usable width across the whole
            mobile-L → laptop range rather than being crushed to a few pixels.

            At xl: there is finally room for everything inline, so the branding
            text, repo-config button, "updated" stamp, and the notification /
            settings / account controls all appear and the hamburger retires.

            Deploy lives in the right-hand group up to 2xl:, then jumps to the
            centre of the bar on the widest viewports (see the centred overlay
            below). It always renders and never wraps to a new row. */}
        <div className="relative flex items-center gap-2 sm:gap-3">
          {/* Centred Deploy — the very widest viewports only. Absolutely centred
              over the bar so it stays put regardless of how wide the side
              groups grow. pointer-events are disabled on the wrapper so the
              empty space either side never swallows clicks meant for the
              controls beneath. It only switches on at 2xl: — below that the side
              groups (branding + repo selector + repo config + inline controls)
              still reach the horizontal centre, so a centred overlay would
              collide with them. Up to 2xl: Deploy stays in the right-hand
              group. */}
          <div className="pointer-events-none absolute inset-x-0 z-10 hidden justify-center 2xl:flex">
            <div className="pointer-events-auto">{deployButton}</div>
          </div>

          {/* Hamburger — far left, below xl. Holds the secondary controls
              (notifications, settings, account, sign out) so the bar never
              overflows and the repo selector keeps usable width through the
              mobile-L → laptop range. The inline controls only appear at xl:,
              where there is finally room for everything at once. */}
          <div className="relative shrink-0 xl:hidden">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                <path
                  fillRule="evenodd"
                  d="M3 5.75A.75.75 0 0 1 3.75 5h12.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 5.75Zm0 4.25A.75.75 0 0 1 3.75 9.25h12.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 10Zm.75 3.5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H3.75Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            {menuOpen && (
              <>
                {/* Click-away backdrop. */}
                <button
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={() => setMenuOpen(false)}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div
                  role="menu"
                  className="absolute left-0 z-20 mt-2 w-56 origin-top-left rounded-xl border border-white/10 bg-[var(--surface-panel)] p-2 shadow-xl"
                >
                  <div className="flex items-center gap-2 border-b border-white/10 px-2 pb-2">
                    {user.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={user.image}
                        alt={user.name}
                        className="h-7 w-7 rounded-full"
                      />
                    )}
                    <span className="truncate text-sm text-white/70">
                      {user.name}
                    </span>
                  </div>
                  {selectedRepo?.isAdmin && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setShowRepoConfig(true);
                      }}
                      className="mt-1 block w-full rounded-lg px-2 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white"
                    >
                      Repo config
                    </button>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void toggleNotify();
                    }}
                    className="block w-full rounded-lg px-2 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white"
                  >
                    {notify ? "Disable notifications" : "Enable notifications"}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setShowSettings(true);
                    }}
                    className="block w-full rounded-lg px-2 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white"
                  >
                    Settings
                  </button>
                  <button
                    role="menuitem"
                    onClick={async () => {
                      setMenuOpen(false);
                      await authClient.signOut();
                      router.refresh();
                    }}
                    className="block w-full rounded-lg px-2 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white"
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            <h1 className="shrink-0 text-2xl font-bold tracking-tight">
              <Link
                href="/"
                className="flex items-center gap-2.5 transition hover:opacity-80"
              >
                <BandolierIcon className="h-7 w-7 shrink-0" />
                <span className="hidden tracking-[0.15em] uppercase xl:inline">
                  Bandolier
                </span>
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
            {selectedRepo?.isAdmin && (
              <button
                onClick={() => setShowRepoConfig(true)}
                className="hidden rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium whitespace-nowrap text-white/70 hover:bg-white/10 hover:text-white xl:inline-flex"
              >
                Repo config
              </button>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {namespace && kubeConfigured && (
              <span className="hidden text-xs text-white/30 xl:inline">
                {agentsLoading
                  ? "Refreshing…"
                  : `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`}
              </span>
            )}

            {/* Secondary controls — inline from xl: up, collapsed into the
                hamburger menu below that. Holding them in the menu through the
                mobile-L → laptop range keeps the bar uncluttered and leaves the
                repo selector its full flexible width. */}
            <div className="hidden items-center gap-2 xl:flex xl:gap-3">
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
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.34 1.94a1.5 1.5 0 0 1 3.32 0l.12.66a1.5 1.5 0 0 0 2.06 1.19l.63-.25a1.5 1.5 0 0 1 1.92 2.05l-.32.6a1.5 1.5 0 0 0 .79 2.16l.64.23a1.5 1.5 0 0 1 0 2.84l-.64.23a1.5 1.5 0 0 0-.79 2.16l.32.6a1.5 1.5 0 0 1-1.92 2.05l-.63-.25a1.5 1.5 0 0 0-2.06 1.19l-.12.66a1.5 1.5 0 0 1-3.32 0l-.12-.66a1.5 1.5 0 0 0-2.06-1.19l-.63.25a1.5 1.5 0 0 1-1.92-2.05l.32-.6a1.5 1.5 0 0 0-.79-2.16l-.64-.23a1.5 1.5 0 0 1 0-2.84l.64-.23a1.5 1.5 0 0 0 .79-2.16l-.32-.6a1.5 1.5 0 0 1 1.92-2.05l.63.25a1.5 1.5 0 0 0 2.06-1.19l.12-.66ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              <div className="flex items-center gap-2 sm:border-l sm:border-white/10 sm:pl-3">
                {user.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.image}
                    alt={user.name}
                    className="h-7 w-7 rounded-full"
                  />
                )}
                <span className="hidden text-sm text-white/60 sm:inline">
                  {user.name}
                </span>
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

            {/* Deploy lives here up to 2xl:, where it moves to the centred
                overlay above. It's the last component in this group to give up
                space and never wraps to a new row. */}
            <div className="2xl:hidden">{deployButton}</div>
          </div>
        </div>
      </header>

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
                Add a kubeconfig to deploy and monitor agents in your cluster.
              </p>
            </div>
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-black hover:bg-sky-500"
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

            {/* Single contiguous task list — newest first. Interactive tasks
                expand in place; the rest open their logs on click. */}
            {!error && agents.length === 0 && !agentsLoading ? (
              <div className="rounded-xl border border-white/10 bg-white/5 py-16 text-center text-white/40">
                No agents running in{" "}
                <code className="text-white/60">{namespace}</code>
              </div>
            ) : agents.length === 0 ? null : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-2 text-xs font-medium tracking-wider text-white/40 uppercase">
                    Tasks
                    <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-white/50">
                      {visibleAgents.length}
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

                {visibleAgents.length === 0 ? (
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
                  <div
                    onKeyDown={handleTableKeyDown}
                    className="overflow-hidden rounded-xl border border-white/10"
                  >
                    {/* table-fixed locks column geometry to the header widths
                        below, so an interactive row expanding in place (a
                        full-width colSpan cell with logs + input) can only push
                        the rows below it down — it can never re-balance the
                        columns the way auto layout did. Percentage widths keep
                        the layout responsive and redistribute proportionally
                        when the optional columns are hidden on narrow
                        viewports. */}
                    <table className="w-full table-fixed text-sm">
                      <thead>
                        <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium tracking-wider text-white/50 uppercase">
                          {[
                            // Status/Output carry pills with hard minimum
                            // widths (e.g. the "Succeeded" status pill, the
                            // "Issue #1234" source link). The compact (narrow)
                            // layout shows only Status/Output/Task/Actions, so
                            // these get a generous share there; in the full
                            // layout (lg+, see below) they shrink once the wide
                            // viewport gives every column room.
                            // Status/Output share the same widths as the
                            // overview panel so the two tables line up.
                            {
                              label: "Status",
                              width: "w-[18%] lg:w-[10%]",
                              center: true,
                            },
                            {
                              label: "Output",
                              width: "w-[23%] lg:w-[11%]",
                              center: true,
                            },
                            // The primary column: `w-auto` so it absorbs all the
                            // width the fixed columns leave behind. A fixed share
                            // here would clamp the description to a constant
                            // width — truncating as if the wide action controls
                            // (confirm/cancel, "End session") were always present
                            // even when only the compact terminate glyph is, and
                            // wasting the freed space. Mirrors the Repository
                            // column in the overview panel.
                            { label: "Task", width: "w-auto" },
                            // The three secondary columns appear only in the full
                            // layout (lg+). Below `lg` — including the 768–1023
                            // tablet band — the row stays readable with
                            // Status/Output/Task alone. (Showing all seven at
                            // `md` starved the pill columns: a centered Status
                            // pill wider than its cell overflowed symmetrically
                            // and bled out past the table's edge, and the
                            // "Issue #N" source spilled into Currently.)
                            {
                              label: "Created by",
                              width: "w-[16%]",
                              optional: true,
                            },
                            {
                              label: "Currently",
                              width: "w-[15%]",
                              optional: true,
                            },
                            {
                              label: "Expires",
                              width: "w-[12%]",
                              optional: true,
                            },
                            // Holds the "End session" button (shown on running
                            // interactive rows) plus the terminate control. The
                            // action controls are compact and wrap on narrow
                            // viewports (see TaskRow / InteractiveRow), so this
                            // column only needs room for the widest single
                            // control — the rest stacks within the cell instead
                            // of overflowing leftward onto the Task description.
                            // Keeping it slim here is what gives the Task column
                            // real width on mobile: a large fixed share starved
                            // the description to a sliver even on rows whose
                            // only action is the small terminate (×) glyph.
                            { label: "", width: "w-[22%] lg:w-[16%]" },
                          ].map((h, i) => (
                            <th
                              key={i}
                              className={`px-3 py-2 align-middle md:px-4 md:py-3 ${h.width} ${h.center ? "text-center" : ""} ${h.optional ? "hidden lg:table-cell" : ""}`}
                            >
                              {h.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {visibleAgents.map((agent) =>
                          agent.interactive && agent.ownedByViewer ? (
                            // Interactive sessions are rows too, expanding in
                            // place to reveal their live logs + input. Only the
                            // owner gets the expanding input row — a
                            // collaborator's session renders as a read-only
                            // task row (logs viewable, no input).
                            <InteractiveRow
                              key={agent.name}
                              agent={agent}
                              namespace={namespace}
                              repoFullName={repoSlug ?? undefined}
                              focusSignal={
                                focusTarget?.name === agent.name
                                  ? focusTarget.token
                                  : null
                              }
                            />
                          ) : (
                            <TaskRow
                              key={agent.name}
                              agent={agent}
                              namespace={namespace}
                              repoFullName={repoSlug ?? undefined}
                              onOpenLogs={setLogPod}
                            />
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
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
      {showRepoConfig && selectedRepo?.isAdmin && (
        <RepoConfigModal
          repoFullName={selectedRepo.fullName}
          onClose={() => setShowRepoConfig(false)}
        />
      )}
    </div>
  );
}
