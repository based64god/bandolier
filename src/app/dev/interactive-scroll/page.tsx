"use client";

import { useState } from "react";

import { InteractiveRow } from "~/app/dashboard/_components/interactive-sessions";
import type { RouterOutputs } from "~/trpc/react";

type Task = RouterOutputs["agents"]["list"][number];

/**
 * Dev-only harness that mounts the real InteractiveRow inside a dashboard-shaped
 * page (header + fixed-layout table + trailing scroll room), so its reveal
 * scroll can be exercised in a real browser. Not linked from the app. The ACP
 * session's tRPC polls fail harmlessly here (no backend) — the row still renders
 * its full-height body, which is all the scroll geometry needs.
 *
 * A Playwright spec (e2e/interactive-scroll.spec.mjs) taps "Simulate awaiting
 * input" to fire the reveal, then asserts the collapsed interactive row lands at
 * the top of the viewport and the composer sits at the bottom — on tall and
 * short viewports alike. The old fixed `85vh` body left the composer floating
 * short of the bottom on tall screens and clipped it off the bottom on short
 * ones.
 */
export default function InteractiveScrollHarness() {
  // Flipped by the button to drive the false->true awaiting transition, which is
  // what reveals a running session (and stacks the taller "Waiting" pill into
  // the row — the worst case for the row-plus-body fit).
  const [awaiting, setAwaiting] = useState(false);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const prompt =
    "an interactive session whose reveal should pin the collapse / end / terminate row to the top and the composer to the bottom";
  const agent = {
    name: "task-scroll-1",
    jobName: "job-scroll-1",
    displayName: prompt.slice(0, 60) + "…",
    prompt,
    status: "Running",
    awaitingInput: awaiting,
    interactive: true,
    ownedByViewer: true,
    tokens: null,
    currently: "waiting for your input",
    source: "manual",
    expiresAt: "2030-01-01T12:00:00.000Z",
  } as unknown as Task;

  // Columns copied from the real task table's <thead> (see TASK_TABLE_COLUMNS):
  // the same percentage widths and labels, so the row's collapsed header and its
  // full-width colSpan body share the real dashboard's column geometry.
  const cols = [
    { width: "w-[18%] md:w-[7.5rem]", label: "Status" },
    { width: "w-[23%] md:w-[7rem]", label: "Output" },
    { width: "w-auto", label: "Task" },
    { width: "w-36 hidden lg:table-cell", label: "Created by" },
    { width: "w-[13%] hidden xl:table-cell", label: "Currently" },
    { width: "w-[9.5rem] hidden lg:table-cell", label: "Expires" },
    { width: "w-[30%] md:w-40", label: "" },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      {/* Chrome above the table, mirroring the real dashboard header's height,
          so revealing the row has something to scroll past to reach the top. */}
      <header className="border-b border-white/10 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex h-9 items-center text-sm text-white/60">
          Interactive scroll harness
        </div>
      </header>

      <main className="flex-1 space-y-6 px-4 py-4 sm:px-6 sm:py-6">
        <button
          data-testid="await"
          onClick={() => setAwaiting(true)}
          className="rounded border border-white/15 px-3 py-1.5 text-sm"
        >
          Simulate awaiting input
        </button>

        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs font-medium tracking-wider text-white/50 uppercase">
                {cols.map((c, i) => (
                  <th
                    key={i}
                    className={
                      "px-3 py-2 align-middle md:px-4 md:py-3 " + c.width
                    }
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody data-testid="rows" className="divide-y divide-white/5">
              <InteractiveRow
                agent={agent}
                namespace="default"
                awaitingCount={1}
              />
            </tbody>
          </table>
        </div>

        {/* Trailing scroll room so the row can always reach the very top of the
            viewport, however tall its body renders. */}
        <div className="h-64" />
      </main>
    </div>
  );
}
