"use client";

import { BackgroundTasksPanel } from "~/app/dashboard/_components/background-tasks-panel";
import type { TimelineItem } from "~/lib/acp/timeline";

/**
 * Dev-only harness that mounts the BackgroundTasksPanel in isolation (no
 * tRPC/ACP/auth), so the pinned indicator and its popout modal can be exercised
 * in a real browser — e.g. with Playwright. Not linked from the app.
 */
export default function BackgroundTasksHarness() {
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  // A subagent spawn whose id matches a background task id, so the panel shows its
  // label; the other task ids don't correlate and fall back to a generic name.
  const items: TimelineItem[] = [
    {
      type: "tool",
      id: "t-agent",
      toolCallId: "task-1",
      kind: "subagent",
      title: "Agent(Explore): map the routes",
      status: "completed",
    },
  ];

  const scenarios = [
    {
      testid: "panel-running",
      label: "Running — two generic, one labelled (labelled last, so it previews)",
      taskIds: ["task-2", "task-3", "task-1"],
      running: true,
    },
    {
      testid: "panel-one",
      label: "Running — a single task",
      taskIds: ["task-9"],
      running: true,
    },
    {
      testid: "panel-empty",
      label: "Drained — indicator pruned (renders nothing)",
      taskIds: [] as string[],
      running: true,
    },
    {
      testid: "panel-not-running",
      label: "Finished session — indicator suppressed even with a stale set",
      taskIds: ["task-1"],
      running: false,
    },
  ];

  return (
    <div className="min-h-screen space-y-8 bg-[#06140c] p-4 text-white">
      <h1 className="text-lg">BackgroundTasksPanel harness</h1>
      {scenarios.map((sc) => (
        <section key={sc.testid} data-testid={sc.testid}>
          <h2 className="mb-1 text-sm text-white/50">{sc.label}</h2>
          <div className="max-w-2xl border border-white/10">
            <BackgroundTasksPanel
              taskIds={sc.taskIds}
              items={items}
              running={sc.running}
            />
            <div className="p-4 text-sm text-white/40">…conversation below…</div>
          </div>
        </section>
      ))}
    </div>
  );
}
