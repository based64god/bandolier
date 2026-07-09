"use client";

import { useEffect, useMemo, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { BandolierIcon } from "./bandolier-icon";
import { useCanGoBack } from "./navigation-history";

// Sidebar structure for a settings page: purpose groups, each listing the
// cards its panel renders. Group and card ids double as URL hashes
// (/settings#kubeconfig), so every entry is deep-linkable; a card hash selects
// its group and scrolls.
export type SettingsNavGroup = {
  id: string;
  label: string;
  items: { id: string; label: string }[];
};

// A titled card on a settings panel. The id is the deep-link/scroll anchor;
// scroll-mt keeps the card clear of the sticky header when jumped to.
export function SettingsCard({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-20 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:p-5"
    >
      {children}
    </section>
  );
}

// The chrome shared by the user and repo settings pages: sticky header,
// group-tab sidebar with hash-driven deep linking, and a panel area that only
// mounts the active group (so a panel's status queries don't fire until it's
// opened — the render prop receives the active group id).
export function SettingsShell({
  title,
  titleAccessory,
  backHref,
  backLabel,
  backToHistory = false,
  nav,
  defaultGroup,
  children,
}: {
  title: string;
  titleAccessory?: React.ReactNode;
  backHref: string;
  backLabel: string;
  // When set, the back control returns to the previous in-app page rather than
  // the fixed backHref — but only when the user actually arrived from within
  // the app. A direct visit (deep link, refresh, new tab) has no prior in-app
  // entry, so we fall back to backHref/backLabel.
  backToHistory?: boolean;
  nav: SettingsNavGroup[];
  defaultGroup: string;
  children: (active: string) => React.ReactNode;
}) {
  const router = useRouter();
  const cameFromApp = useCanGoBack();
  const [active, setActive] = useState(defaultGroup);
  const canGoBack = backToHistory && cameFromApp;

  const groupForHash = useMemo(
    () =>
      new Map<string, string>(
        nav.flatMap((g) => [
          [g.id, g.id] as const,
          ...g.items.map((i) => [i.id, g.id] as const),
        ]),
      ),
    [nav],
  );

  // The active group follows the URL hash — both on load (deep links) and on
  // every in-page anchor click, which fires hashchange. A card-level hash
  // (#kubeconfig) selects its group; the browser's own anchor scroll misses
  // when the card's panel wasn't mounted yet, so scroll explicitly once it is.
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.slice(1);
      const group = groupForHash.get(hash);
      if (!group) return;
      setActive(group);
      if (hash !== group) {
        requestAnimationFrame(() => {
          document
            .getElementById(hash)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [groupForHash]);

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Link href="/" className="transition hover:opacity-80">
              <BandolierIcon className="h-7 w-7 shrink-0" />
            </Link>
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {titleAccessory}
          </div>
          {canGoBack ? (
            <button
              type="button"
              onClick={() => router.back()}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 hover:text-white"
            >
              ← Back
            </button>
          ) : (
            <Link
              href={backHref}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 hover:text-white"
            >
              ← {backLabel}
            </Link>
          )}
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row md:gap-10 md:py-8">
        {/* Group tabs — a wrapping horizontal row below md:, a sidebar from
            md: up. Below md: the tabs wrap onto as many rows as they need so
            they never run off the side of a narrow viewport; flex-nowrap
            restores the single column once the sidebar layout takes over.
            The sidebar sticks below the sticky header while the panel
            scrolls; self-start keeps it its natural height (a flex child
            stretched to the column's full height has no room to stick).
            The sticky offset must equal the nav's natural resting position —
            the 59px header (py-3 + the 34px back-link + border-b) plus this
            wrapper's md:py-8 — or the sidebar visibly slides that difference
            before pinning. */}
        <nav className="flex flex-wrap gap-1 md:sticky md:top-[91px] md:w-52 md:shrink-0 md:flex-col md:flex-nowrap md:gap-4 md:self-start">
          {nav.map((group) => (
            <div key={group.id} className="md:space-y-1">
              <a
                href={`#${group.id}`}
                aria-current={active === group.id ? "page" : undefined}
                className={`block rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${
                  active === group.id
                    ? "bg-white/10 font-medium text-white"
                    : "text-white/50 hover:bg-white/5 hover:text-white"
                }`}
              >
                {group.label}
              </a>
              <ul className="hidden md:block">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      className="block rounded-lg py-1 pr-3 pl-6 text-xs text-white/40 hover:text-white"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <main className="min-w-0 flex-1 space-y-4">{children(active)}</main>
      </div>
    </div>
  );
}
