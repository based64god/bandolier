"use client";

import { useState } from "react";

// A tiny playable prop for the marketing page: a MacBook that you can slam
// shut, next to a cluster of agents that keep chugging regardless. It exists to
// sell the whole joke — the lid state is purely cosmetic, the "agents" are
// canned, and nothing here talks to the real product.
const AGENTS = [
  { repo: "acme/checkout", task: "fix flaky payment test" },
  { repo: "acme/web", task: "migrate to Tailwind v4" },
  { repo: "acme/infra", task: "rotate the leaked API key" },
];

export function LidDemo() {
  const [closed, setClosed] = useState(false);

  return (
    <div className="flex flex-col items-center gap-8">
      <button
        type="button"
        onClick={() => setClosed((c) => !c)}
        aria-pressed={closed}
        className="group flex flex-col items-center gap-4"
      >
        {/* The laptop. The lid rotates down onto the base when "closed". */}
        <div
          className="relative"
          style={{ perspective: "600px" }}
          aria-hidden="true"
        >
          <div
            className="mx-auto h-24 w-40 origin-bottom rounded-t-lg border border-white/20 bg-gradient-to-b from-white/10 to-white/5 transition-transform duration-700 ease-in-out motion-reduce:transition-none"
            style={{
              transform: closed ? "rotateX(-88deg)" : "rotateX(0deg)",
              transformStyle: "preserve-3d",
            }}
          >
            <div className="flex h-full w-full items-center justify-center">
              <span
                className={`text-xs font-medium tracking-widest text-purple-300 transition-opacity duration-300 ${
                  closed ? "opacity-0" : "opacity-100"
                }`}
              >
                zzz…
              </span>
            </div>
          </div>
          {/* The base / keyboard deck. */}
          <div className="mx-auto -mt-px h-3 w-44 rounded-b-lg border border-t-0 border-white/20 bg-white/10" />
          <div className="mx-auto h-1 w-16 rounded-b-md bg-white/10" />
        </div>
        <span className="rounded-full border border-white/15 px-4 py-1.5 text-sm font-medium text-white/80 transition group-hover:border-purple-400/50 group-hover:text-white">
          {closed ? "Lid closed — reopen it" : "Slam the lid shut"}
        </span>
      </button>

      {/* The agents, running on someone else's computer. */}
      <div className="w-full max-w-md space-y-2">
        {AGENTS.map((agent, i) => (
          <div
            key={agent.repo}
            className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left"
          >
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75 motion-reduce:hidden" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-purple-500" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-white">{agent.task}</p>
              <p className="truncate text-xs text-white/40">{agent.repo}</p>
            </div>
            <span
              className="shrink-0 animate-pulse text-xs font-medium text-purple-300 motion-reduce:animate-none"
              style={{ animationDelay: `${i * 0.3}s` }}
            >
              running
            </span>
          </div>
        ))}
        <p className="pt-1 text-center text-xs text-white/40">
          {closed
            ? "Your MacBook is asleep. The agents did not notice."
            : "These run on the cluster, not your lap."}
        </p>
      </div>
    </div>
  );
}
