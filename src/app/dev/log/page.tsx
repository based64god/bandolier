"use client";

import { HarnessSegment } from "~/app/dashboard/_components/log-modal";

/**
 * Dev-only harness mounting HarnessSegment in isolation (no tRPC/log fetch), so
 * the nested tool-output expander can be exercised in a real browser — e.g. with
 * Playwright. Not linked from the app.
 *
 * The fixture is a slice of the pod-log transcript: two tool calls (→ lines)
 * whose captured stdout/stderr the harness recorded as ←-tagged lines, which the
 * segment folds behind a per-call "output" expander.
 */
export default function LogHarness() {
  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const withOutput = [
    "15:04:05 [harness] → Bash: git status",
    "15:04:05 [harness]   ← On branch main",
    "15:04:05 [harness]   ← nothing to commit, working tree clean",
    "15:04:06 [harness] → Read: src/index.ts",
    "15:04:06 [harness]   ← export const answer = 42;",
  ];
  const noOutput = ["15:04:07 [harness] → Grep: TODO in src"];

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">Log harness</h1>
      <div
        data-testid="with-output"
        className="mb-4 max-w-2xl rounded-xl border border-white/10 bg-black/30 p-4 text-[13px]"
      >
        <HarnessSegment lines={withOutput} />
      </div>
      <div
        data-testid="no-output"
        className="max-w-2xl rounded-xl border border-white/10 bg-black/30 p-4 text-[13px]"
      >
        <HarnessSegment lines={noOutput} />
      </div>
    </div>
  );
}
