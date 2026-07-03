"use client";

import { useState } from "react";

import { TaskRow } from "~/app/dashboard/_components/task-row";
import type { RouterOutputs } from "~/trpc/react";

type Task = RouterOutputs["agents"]["list"][number];

/**
 * Dev-only harness that mounts a single TaskRow inside a table whose column
 * geometry mirrors the real dashboard (table-fixed + the same percentage
 * widths), so its Actions cell — the terminate (×) glyph vs. the confirm/cancel
 * pair — can be exercised in a real browser at a narrow (mobile) viewport. Not
 * linked from the app. A Playwright spec taps the glyph to reveal Confirm/Cancel
 * and asserts the row's height doesn't change between the two states.
 */
export default function TaskRowHarness() {
  const [lastOpened, setLastOpened] = useState<string | null>(null);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const agent = {
    name: "task-abc123",
    displayName: "fix the confirmation button height on mobile",
    status: "Running",
    ownedByViewer: true,
    tokens: null,
    currently: "editing task-row.tsx",
    source: "manual",
  } as unknown as Task;

  // Column widths copied from the real task table's <thead> (agent-dashboard).
  const cols = [
    "w-[18%] lg:w-[10%]",
    "w-[23%] lg:w-[11%]",
    "w-auto",
    "w-[16%] hidden lg:table-cell",
    "w-[15%] hidden lg:table-cell",
    "w-[12%] hidden lg:table-cell",
    "w-[30%] lg:w-[16%]",
  ];

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">TaskRow harness</h1>
      <div className="overflow-hidden rounded-xl border border-white/10">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs text-white/50">
              {cols.map((w, i) => (
                <th key={i} className={`px-3 py-2 ${w}`} />
              ))}
            </tr>
          </thead>
          <tbody data-testid="rows" className="divide-y divide-white/5">
            <TaskRow
              agent={agent}
              namespace="default"
              onOpenLogs={(name) => setLastOpened(name)}
            />
          </tbody>
        </table>
      </div>
      <p data-testid="last-opened" className="mt-4 font-mono text-sm">
        {lastOpened ?? ""}
      </p>
    </div>
  );
}
