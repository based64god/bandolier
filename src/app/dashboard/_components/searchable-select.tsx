"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SelectOption {
  /** Unique value submitted on selection. */
  value: string;
  /** Rendered in both the trigger and the list row. */
  label: ReactNode;
  /** Lowercased text matched against the search query. */
  searchText: string;
}

/**
 * Dark-styled dropdown with a search box, matching the repo selector. Generic so
 * it can back any picker (repos, issues, …) instead of a native <select>.
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
  /** Extra classes for the root (e.g. a fixed width); defaults to full width. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  function choose(next: string | null) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => {
          setSearch("");
          setOpen((o) => !o);
        }}
        disabled={loading || disabled}
        className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm transition hover:border-white/20 hover:bg-white/10 disabled:opacity-40"
      >
        <span className="min-w-0 flex-1 truncate text-left">
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

      {open && (
        <div className="absolute top-full left-0 z-20 mt-1.5 w-full min-w-72 overflow-hidden rounded-xl border border-white/10 bg-[#0d0d20] shadow-2xl">
          <div className="border-b border-white/10 p-2">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
            />
          </div>

          {options.length === 0 ? (
            <p className="px-4 py-3 text-xs text-white/30">{emptyText}</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {clearLabel !== undefined && !query && (
                <li>
                  <button
                    type="button"
                    onClick={() => choose(null)}
                    className={`flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm transition ${
                      value === null
                        ? "bg-purple-600/40 text-white"
                        : "text-white/50 hover:bg-white/5"
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
                filtered.map((o) => {
                  const isSelected = o.value === value;
                  return (
                    <li key={o.value}>
                      <button
                        type="button"
                        onClick={() => choose(o.value)}
                        className={`flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm transition ${
                          isSelected ? "bg-purple-600/40" : "hover:bg-white/5"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {o.label}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
