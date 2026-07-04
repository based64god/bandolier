"use client";

import { useState } from "react";

import { StatusBadge } from "~/app/dashboard/_components/status-badge";

/**
 * Dev-only harness that mounts StatusBadge in isolation (no tRPC/auth), so the
 * tappable Failed pill and its failure popover can be exercised in a real
 * browser — e.g. with Playwright. Not linked from the app. The badges sit
 * inside an `overflow-hidden` wrapper like the real task tables, so the spec
 * also proves the fixed-position popover escapes the clipping.
 */
export default function StatusBadgeHarness() {
  const [rowClicks, setRowClicks] = useState(0);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">StatusBadge harness</h1>
      <div
        onClick={() => setRowClicks((n) => n + 1)}
        className="max-w-md space-y-3 overflow-hidden rounded-xl border border-white/10 p-4"
      >
        <div data-testid="oom">
          <StatusBadge
            status="Failed"
            failure={{ reason: "OOMKilled", exitCode: 137, message: null }}
          />
        </div>
        <div data-testid="crash">
          <StatusBadge
            status="Failed"
            failure={{ reason: "Error", exitCode: 1, message: "panic: boom" }}
          />
        </div>
        <div data-testid="failed-no-detail">
          <StatusBadge status="Failed" />
        </div>
        <div data-testid="succeeded">
          <StatusBadge status="Succeeded" />
        </div>
        <div data-testid="finalizing">
          <StatusBadge status="Finalizing" />
        </div>
      </div>
      {/* Mirrors the task rows' click-to-open-logs behaviour: a badge tap must
          not count as a row click. */}
      <p data-testid="row-clicks" className="mt-4 font-mono text-sm">
        {rowClicks}
      </p>
    </div>
  );
}
