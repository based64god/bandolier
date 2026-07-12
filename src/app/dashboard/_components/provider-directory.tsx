"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

// The unified model-provider directory: a searchable accordion where every
// provider — the four with rich, dedicated credential forms (Anthropic,
// OpenAI, Gemini, Bedrock) and the ~90 gollm-proxied ones — is a card in one
// visual system. No implicit tiers: configured providers sort to the top with
// a "Configured" badge, and any provider can be found by search and expanded
// to its own form. The scope-specific wrapper (user settings or repo settings)
// assembles the entries; this shell owns the search, sort, and expand/collapse.

export type ProviderAccent = "purple" | "teal" | "blue" | "orange" | "sky";

const ACCENT_DOT: Record<ProviderAccent, string> = {
  purple: "bg-purple-400",
  teal: "bg-teal-400",
  blue: "bg-blue-400",
  orange: "bg-orange-400",
  sky: "bg-sky-400",
};

export interface ProviderEntry {
  /** Stable id (provider name); also the expand key. */
  id: string;
  label: string;
  accent: ProviderAccent;
  /** Whether the provider has a credential configured in this scope. */
  configured: boolean;
  /** Extra search terms (aliases, backend id) beyond the label. */
  keywords?: string;
  /**
   * A concise "credential shape" subtitle shown under the label in the
   * collapsed row (e.g. "Access key + secret + region"), so the kind of
   * credential a provider expects is legible without expanding the card.
   */
  hint?: string;
  /**
   * Discoverability weight for the unconfigured group only (higher sorts
   * earlier). Keeps the common providers near the top of a fresh list without a
   * separate visual tier — every entry is the same kind of card. Default 0.
   */
  priority?: number;
  /** The credential form, mounted only while the card is expanded. */
  body: ReactNode;
}

export function ProviderDirectory({
  entries,
  intro,
}: {
  entries: ProviderEntry[];
  intro?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? entries.filter((e) =>
          `${e.label} ${e.id} ${e.keywords ?? ""}`.toLowerCase().includes(q),
        )
      : entries;
    // Configured first, then by discoverability weight, then alphabetical.
    return [...matches].sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1;
      const pri = (b.priority ?? 0) - (a.priority ?? 0);
      if (pri !== 0) return pri;
      return a.label.localeCompare(b.label);
    });
  }, [entries, query]);

  const configuredCount = entries.filter((e) => e.configured).length;

  return (
    <div className="space-y-3">
      {intro}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${entries.length} providers…`}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-sky-400/60 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-white/40">
          {configuredCount} configured
        </span>
      </div>

      <div className="space-y-1.5">
        {filtered.map((entry) => {
          const isOpen = expanded === entry.id;
          return (
            <div
              key={entry.id}
              className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
            >
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : entry.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]"
                aria-expanded={isOpen}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    entry.configured ? ACCENT_DOT[entry.accent] : "bg-white/15"
                  }`}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-white">
                    {entry.label}
                  </span>
                  {entry.hint && (
                    <span className="truncate text-xs text-white/40">
                      {entry.hint}
                    </span>
                  )}
                </span>
                {entry.configured && (
                  <span className="shrink-0 rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-300">
                    Configured
                  </span>
                )}
                <span
                  className={`shrink-0 text-white/30 transition-transform ${
                    isOpen ? "rotate-90" : ""
                  }`}
                  aria-hidden
                >
                  ›
                </span>
              </button>
              {isOpen && (
                <div className="border-t border-white/10 px-4 py-3">
                  {entry.body}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="px-1 py-4 text-xs text-white/30">
            No providers match “{query}”.
          </p>
        )}
      </div>
    </div>
  );
}
