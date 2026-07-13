"use client";

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  /** Unique value submitted on selection. */
  value: string;
  /** Rendered in both the trigger and the list row. */
  label: ReactNode;
  /** Lowercased text matched against the search query. */
  searchText: string;
}

// Minimum panel width, matching the old `min-w-72` (18rem). The panel otherwise
// tracks the trigger's width.
const MIN_PANEL_WIDTH = 288;
// Gap between the trigger and the panel, and the panel and the viewport edge.
const GAP = 6;
const VIEWPORT_MARGIN = 8;

interface PanelCoords {
  left: number;
  width: number;
  /** Set when opening downward. */
  top?: number;
  /** Set when opening upward (distance from viewport bottom). */
  bottom?: number;
  maxHeight: number;
}

/**
 * Dark-styled dropdown with a search box, matching the repo selector. Generic so
 * it can back any picker (repos, issues, …) instead of a native <select>.
 *
 * The open panel renders in a portal with fixed positioning so it escapes any
 * `overflow-hidden`/scrolling ancestor (e.g. a modal body): it opens downward,
 * flips upward when there isn't room below, and caps its height to the available
 * viewport space so a long list never spills out of view.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  loading = false,
  disabled = false,
  searchPlaceholder = "Search…",
  emptyText = "No options.",
  clearLabel,
  recentValues,
  className = "",
}: {
  options: SelectOption[];
  /** Selected value, or null for the cleared/none state. */
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  loading?: boolean;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  /** When set, a "none" row appears and this is shown in the trigger for null. */
  clearLabel?: string;
  /**
   * Values shown in a "Recent" group above the full list while the search box
   * is empty (the full list keeps them too). Values without a matching option
   * are ignored.
   */
  recentValues?: string[];
  /** Extra classes for the root (e.g. a fixed width); defaults to full width. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Index into `navValues` (below) of the arrow-key-highlighted row.
  const [highlight, setHighlight] = useState(0);
  const [coords, setCoords] = useState<PanelCoords | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Position the panel relative to the trigger, flipping up and clamping height
  // when there isn't enough room below. Recomputed on open, scroll, and resize.
  useLayoutEffect(() => {
    if (!open) return;

    function updatePosition() {
      const trigger = ref.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();

      const spaceBelow = window.innerHeight - r.bottom - GAP - VIEWPORT_MARGIN;
      const spaceAbove = r.top - GAP - VIEWPORT_MARGIN;
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(
        160,
        Math.min(360, openUp ? spaceAbove : spaceBelow),
      );

      const width = Math.max(r.width, MIN_PANEL_WIDTH);
      let left = r.left;
      if (left + width > window.innerWidth - VIEWPORT_MARGIN) {
        left = window.innerWidth - width - VIEWPORT_MARGIN;
      }
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

      setCoords({
        left,
        width,
        top: openUp ? undefined : r.bottom + GAP,
        bottom: openUp ? window.innerHeight - r.top + GAP : undefined,
        maxHeight,
      });
    }

    updatePosition();
    // Capture scrolls on any ancestor (modal bodies scroll) plus resizes.
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      // The panel lives in a portal outside `ref`, so check both.
      if (ref.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const query = search.trim().toLowerCase();
  const filtered = query
    ? options.filter((o) => o.searchText.includes(query))
    : options;

  const selected = options.find((o) => o.value === value) ?? null;

  // Recent picks, resolved against the option list (stale values drop out).
  // They render as a headed group above the full list, but only while the
  // search box is empty — search results stay a single flat list.
  const recentOptions = (recentValues ?? [])
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is SelectOption => o !== undefined);
  const showRecent = !query && recentOptions.length > 0;

  const sections: { heading: string; options: SelectOption[] }[] = showRecent
    ? [
        { heading: "Recent", options: recentOptions },
        { heading: "All", options: filtered },
      ]
    : [{ heading: "", options: filtered }];

  // The clear/none row (when present) is keyboard-navigable too, so arrow keys
  // and Enter walk the same list the user sees, in display order.
  const showClear = clearLabel !== undefined && !query;
  const navValues: (string | null)[] = [
    ...(showClear ? [null] : []),
    ...sections.flatMap((s) => s.options.map((o) => o.value)),
  ];

  // The nav index of the currently-selected value within the list as it will
  // render on open (search resets to empty, so the recent group counts), so
  // opening can start arrow-key navigation on the current selection rather
  // than always at the top. Falls back to the first row.
  function selectedNavIndex() {
    const clearOffset = clearLabel !== undefined ? 1 : 0;
    const recent = recentOptions.findIndex((o) => o.value === value);
    if (recent >= 0) return recent + clearOffset;
    const i = options.findIndex((o) => o.value === value);
    if (i < 0) return 0;
    return i + recentOptions.length + clearOffset;
  }

  function openDropdown() {
    setSearch("");
    setHighlight(value === null ? 0 : selectedNavIndex());
    setOpen(true);
  }

  // Keep the highlighted row scrolled into view as it moves past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-nav="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function choose(next: string | null) {
    onChange(next);
    setOpen(false);
  }

  function handleNavKey(e: React.KeyboardEvent) {
    const last = navValues.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Wrap to the top so the list cycles instead of dead-ending.
      setHighlight((h) => (h >= last ? 0 : h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? last : h - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(last);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (navValues.length > 0) {
        choose(navValues[Math.min(highlight, last)] ?? null);
      }
    }
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => {
          if (open) setOpen(false);
          else openDropdown();
        }}
        onKeyDown={(e) => {
          // Open on arrow/Enter/Space from the closed trigger, then let the
          // search box take over navigation (it auto-focuses on open).
          if (
            !open &&
            (e.key === "ArrowDown" ||
              e.key === "ArrowUp" ||
              e.key === "Enter" ||
              e.key === " ")
          ) {
            e.preventDefault();
            openDropdown();
          }
        }}
        disabled={loading || disabled}
        className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm transition hover:border-white/20 hover:bg-white/10 disabled:opacity-40"
      >
        <span className="flex min-w-0 flex-1 items-center text-left">
          {loading ? (
            <span className="text-white/40">Loading…</span>
          ) : selected ? (
            selected.label
          ) : (
            <span className="text-white/40">{clearLabel ?? placeholder}</span>
          )}
        </span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`h-3.5 w-3.5 shrink-0 text-white/40 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              left: coords.left,
              width: coords.width,
              top: coords.top,
              bottom: coords.bottom,
              maxHeight: coords.maxHeight,
            }}
            className="z-50 flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[var(--surface-panel)] shadow-2xl"
          >
            <div className="border-b border-white/10 p-2">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={handleNavKey}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
              />
            </div>

            {options.length === 0 ? (
              <p className="px-4 py-3 text-xs text-white/30">{emptyText}</p>
            ) : (
              <ul ref={listRef} className="flex-1 overflow-y-auto py-1">
                {showClear && (
                  <li>
                    <button
                      type="button"
                      data-nav={0}
                      onClick={() => choose(null)}
                      onMouseEnter={() => setHighlight(0)}
                      className={`flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm transition ${
                        value === null
                          ? "bg-purple-600/40 text-white"
                          : highlight === 0
                            ? "bg-white/10 text-white/80"
                            : "text-white/50"
                      }`}
                    >
                      <span className="flex-1 truncate">{clearLabel}</span>
                    </button>
                  </li>
                )}
                {filtered.length === 0 ? (
                  <li className="px-4 py-3 text-xs text-white/30">
                    No matches for &ldquo;{search}&rdquo;.
                  </li>
                ) : (
                  sections.map((section, si) => {
                    // Nav indices run continuously across sections (after the
                    // clear row), matching `navValues`; headings don't count.
                    const base =
                      (showClear ? 1 : 0) +
                      sections
                        .slice(0, si)
                        .reduce((n, s) => n + s.options.length, 0);
                    return (
                      <Fragment key={section.heading || "all"}>
                        {section.heading && (
                          <li className="px-4 pt-2 pb-1 text-[10px] font-medium tracking-wider text-white/30 uppercase">
                            {section.heading}
                          </li>
                        )}
                        {section.options.map((o, i) => {
                          const isSelected = o.value === value;
                          const navIndex = base + i;
                          const isHighlighted = highlight === navIndex;
                          return (
                            // A recent option repeats in the full list below,
                            // so keys are namespaced per section.
                            <li key={`${section.heading}:${o.value}`}>
                              <button
                                type="button"
                                data-nav={navIndex}
                                onClick={() => choose(o.value)}
                                onMouseEnter={() => setHighlight(navIndex)}
                                className={`flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm transition ${
                                  isSelected
                                    ? "bg-purple-600/40"
                                    : isHighlighted
                                      ? "bg-white/10"
                                      : ""
                                }`}
                              >
                                <span className="flex min-w-0 flex-1 items-center">
                                  {o.label}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </Fragment>
                    );
                  })
                )}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
