"use client";

import { useState } from "react";

import {
  PendingDeployRow,
  TaskRow,
} from "~/app/dashboard/_components/task-row";
import type { RouterOutputs } from "~/trpc/react";

type Task = RouterOutputs["agents"]["list"][number];

/**
 * Dev-only harness that mounts TaskRow (plus a just-deployed PendingDeployRow)
 * inside a table whose column geometry mirrors the real dashboard (table-fixed +
 * the same percentage widths), so the rows can be exercised in a real browser.
 * Not linked from the app. A Playwright spec taps the terminate (×) glyph to
 * reveal Confirm/Cancel and asserts the row's height doesn't change between the
 * two states (narrow viewport), and asserts a task description fills its Task
 * column — truncating only where it meets the row's trailing element (wide
 * viewport).
 */
export default function TaskRowHarness() {
  const [lastOpened, setLastOpened] = useState<string | null>(null);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  // An ad-hoc task whose stored display name is the server's 60-char preview of
  // the prompt. The cell must render the full prompt (see taskNameLabel) so the
  // description fills a wide Task column instead of stopping at the preview.
  const prompt =
    "fix the confirmation button height on mobile so the row keeps a constant height when the confirm and cancel pair replaces the terminate glyph";
  const agent = {
    name: "task-abc123",
    displayName: `${prompt.slice(0, 60)}…`,
    prompt,
    status: "Running",
    ownedByViewer: true,
    tokens: null,
    currently: "editing task-row.tsx",
    source: "manual",
  } as unknown as Task;

  // Worst case for the narrow mobile Task column: a resumed run (the amber
  // lineage chip) that is also reporting tokens. The chip and the token readout
  // both sit in the Task cell beside the truncating name, so a too-narrow column
  // shoves the token count off to the right, past the cell and toward the
  // action control. The task-row spec asserts the token stays inside the cell on
  // a phone-width viewport (see the mobile checks there). "88.8K" is the widest
  // realistic count (5 chars); the badge is at its full "↻ resumed" width.
  const resumedAgent = {
    name: "task-resumed",
    displayName: "a resumed follow-up task",
    status: "Running",
    ownedByViewer: true,
    parentJobName: "task-parent-xyz",
    parentDisplayName: "the parent run",
    tokens: {
      inputTokens: 88800,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    currently: "editing task-row.tsx",
    source: "manual",
  } as unknown as Task;

  // Worst-case column content, for measuring the layout: the widest realistic
  // "Created by" values (an Issue #NNNNN badge; a maximum-length 39-char GitHub
  // username), the widest "Expires" form (a not-today date with 2-digit day +
  // 2-digit hour), the widest status pill, and an Output badge.
  const wideExpiry = new Date(
    new Date().getFullYear() + 1,
    11,
    28,
    12,
    59,
  ).toISOString();
  const wideAgents = [
    {
      name: "task-issue-wide",
      displayName: "a task created from a github issue with a long name",
      status: "Terminating",
      ownedByViewer: true,
      tokens: null,
      currently: "summarizing results into the linked issue thread",
      source: "github-issue",
      issueUrl: "https://github.com/acme/widgets/issues/12345",
      issueNumber: "12345",
      issueState: "open",
      pullRequestUrl: "https://github.com/acme/widgets/pull/67890",
      pullRequestState: "merged",
      expiresAt: wideExpiry,
    },
    {
      name: "task-user-wide",
      displayName: "a task created by hand from the dashboard composer",
      status: "Succeeded",
      ownedByViewer: true,
      tokens: null,
      currently: "editing task-row.tsx",
      source: "manual",
      createdBy: "a-maximum-length-github-username-39-chr",
      createdIssueUrl: "https://github.com/acme/widgets/issues/24680",
      createdIssueState: "completed",
      expiresAt: wideExpiry,
    },
  ] as unknown as Task[];

  // Columns copied from the real task table's <thead> (agent-dashboard): the
  // same percentage widths and the same labels, so the header row can be
  // measured here (does a label wrap at `lg`?) without the real dashboard's
  // auth/data.
  const cols = [
    { width: "w-[17%] md:w-[7.5rem]", label: "Status", center: true },
    { width: "w-[20%] md:w-[7rem]", label: "Output", center: true },
    { width: "w-auto", label: "Task" },
    { width: "w-36 hidden lg:table-cell", label: "Created by" },
    { width: "w-[13%] hidden xl:table-cell", label: "Currently" },
    { width: "w-[9.5rem] hidden lg:table-cell", label: "Expires" },
    { width: "w-24 md:w-40", label: "" },
  ];

  return (
    <div className="min-h-screen bg-[#06140c] px-4 py-8 text-white sm:px-6">
      <h1 className="mb-4 text-lg">TaskRow harness</h1>
      <div className="overflow-hidden rounded-xl border border-white/10">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs font-medium tracking-wider text-white/50 uppercase">
              {cols.map((c, i) => (
                <th
                  key={i}
                  data-testid={`header-${i}`}
                  className={`px-3 py-2 align-middle md:px-4 md:py-3 ${c.width} ${c.center ? "text-center" : ""}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-testid="rows" className="divide-y divide-white/5">
            <TaskRow
              agent={agent}
              namespace="default"
              onOpenLogs={(name) => setLastOpened(name)}
            />
            {/* Resumed + token worst case for the narrow mobile Task column. */}
            <TaskRow
              agent={resumedAgent}
              namespace="default"
              onOpenLogs={(name) => setLastOpened(name)}
            />
            {wideAgents.map((a) => (
              <TaskRow
                key={a.name}
                agent={a}
                namespace="default"
                onOpenLogs={(name) => setLastOpened(name)}
              />
            ))}
            {/* A just-deployed placeholder row. Its name is short enough to sit
                well within a wide Task column, letting the task-row spec assert
                the description fills the column — pinning the trailing
                "propagating…" label to the column's right edge (so the name only
                truncates where it would meet the label), matching the live rows
                above. */}
            <PendingDeployRow displayName="a pending deploy" />
          </tbody>
        </table>
      </div>
      <p data-testid="last-opened" className="mt-4 font-mono text-sm">
        {lastOpened ?? ""}
      </p>
    </div>
  );
}
