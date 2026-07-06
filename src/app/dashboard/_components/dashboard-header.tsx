"use client";

import { useState } from "react";

import Link from "next/link";

import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { SearchableSelect, type SelectOption } from "./searchable-select";
import { useRecentRepos } from "./recent-repos";

export type Repo = {
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
  const recentRepos = useRecentRepos();

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
      recentValues={recentRepos}
      searchPlaceholder="Search repositories…"
      emptyText="No repositories found. Sign out and back in to grant repo access."
    />
  );
}

// Shared look for the entries in both dropdown menus (hamburger and avatar).
const menuItemClass =
  "block w-full rounded-lg px-2 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white";

// Avatar-anchored dropdown holding the header's secondary account actions
// (notification toggle, settings, sign out). Rendered from `xl:` up; below
// that the same actions live in the hamburger menu instead. A purple dot on
// the avatar keeps the notification state readable at a glance now that the
// bell no longer sits in the bar.
function UserMenu({
  user,
  notify,
  onToggleNotify,
  onShowSettings,
  onSignOut,
}: {
  user: { name: string; image?: string | null };
  notify: boolean;
  onToggleNotify: () => void;
  onShowSettings: () => void;
  onSignOut: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  const closeAnd = (action: () => void | Promise<void>) => () => {
    setOpen(false);
    void action();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-white/10"
      >
        <span className="relative">
          {user.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.image}
              alt={user.name}
              className="h-7 w-7 rounded-full"
            />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-sm text-white/70">
              {user.name.charAt(0).toUpperCase()}
            </span>
          )}
          {notify && (
            <span
              title="Completion alerts on"
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-purple-400"
            />
          )}
        </span>
        <span className="text-sm text-white/60">{user.name}</span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3.5 w-3.5 text-white/40"
        >
          <path
            fillRule="evenodd"
            d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <>
          {/* Click-away backdrop. */}
          <button
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-2 w-56 origin-top-right rounded-xl border border-white/10 bg-[var(--surface-panel)] p-2 shadow-xl"
          >
            <button
              role="menuitem"
              onClick={closeAnd(onToggleNotify)}
              className={menuItemClass}
            >
              {notify ? "Disable notifications" : "Enable notifications"}
            </button>
            <button
              role="menuitem"
              onClick={closeAnd(onShowSettings)}
              className={menuItemClass}
            >
              Settings
            </button>
            <button
              role="menuitem"
              onClick={closeAnd(onSignOut)}
              className={menuItemClass}
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The dashboard's top bar: branding, repo selector, and the deploy button plus
 * the secondary controls (notifications, settings, repo config, account, sign
 * out). Those secondary actions are declared once as handlers and rendered in
 * two layouts — an avatar dropdown from `xl:` up, collapsed into a hamburger
 * menu below that — so a single source of truth drives both.
 */
export function DashboardHeader({
  user,
  repos,
  selectedRepo,
  reposLoading,
  namespace,
  kubeConfigured,
  agentsLoading,
  dataUpdatedAt,
  notify,
  onRepoChange,
  onToggleNotify,
  onDeploy,
  onShowSettings,
  onShowRepoConfig,
  onSignOut,
}: {
  user: { name: string; image?: string | null };
  repos: Repo[];
  selectedRepo: Repo | null;
  reposLoading: boolean;
  namespace: string | null;
  kubeConfigured: boolean;
  agentsLoading: boolean;
  dataUpdatedAt: number;
  notify: boolean;
  onRepoChange: (fullName: string) => void;
  onToggleNotify: () => void;
  onDeploy: () => void;
  onShowSettings: () => void;
  onShowRepoConfig: () => void;
  onSignOut: () => void | Promise<void>;
}) {
  // Mobile-only: the secondary header controls collapse into this menu so the
  // bar stays within the viewport on narrow screens.
  const [menuOpen, setMenuOpen] = useState(false);

  const canManageRepo = selectedRepo?.isAdmin ?? false;

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
        onClick={onDeploy}
        className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-black hover:bg-purple-500"
      >
        +<span className="hidden sm:inline"> Deploy Agent</span>
      </button>
    ) : null;

  return (
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
                {canManageRepo && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onShowRepoConfig();
                    }}
                    className={`mt-1 ${menuItemClass}`}
                  >
                    Repo config
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleNotify();
                  }}
                  className={menuItemClass}
                >
                  {notify ? "Disable notifications" : "Enable notifications"}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onShowSettings();
                  }}
                  className={menuItemClass}
                >
                  Settings
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void onSignOut();
                  }}
                  className={menuItemClass}
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
            onChange={onRepoChange}
            loading={reposLoading}
          />

          {/* Repo config (webhooks + agent image) — only when the user can
              manage this repo (admin on GitHub). Kept on the left so toggling
              it doesn't shift the Deploy button. */}
          {canManageRepo && (
            <button
              onClick={onShowRepoConfig}
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

          {/* Secondary controls — the avatar dropdown from xl: up, collapsed
              into the hamburger menu below that. Holding them in a menu
              through the mobile-L → laptop range keeps the bar uncluttered
              and leaves the repo selector its full flexible width. */}
          <div className="hidden xl:block">
            <UserMenu
              user={user}
              notify={notify}
              onToggleNotify={onToggleNotify}
              onShowSettings={onShowSettings}
              onSignOut={onSignOut}
            />
          </div>

          {/* Deploy lives here up to 2xl:, where it moves to the centred
              overlay above. It's the last component in this group to give up
              space and never wraps to a new row. */}
          <div className="2xl:hidden">{deployButton}</div>
        </div>
      </div>
    </header>
  );
}
