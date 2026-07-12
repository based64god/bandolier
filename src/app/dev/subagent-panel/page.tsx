"use client";

import { SubagentPanel } from "~/app/dashboard/_components/subagent-panel";
import type { TimelineItem } from "~/lib/acp/timeline";

/**
 * Dev-only harness that mounts the SubagentPanel in isolation (no tRPC/ACP/auth),
 * so the pinned card and its popout modal can be exercised in a real browser —
 * e.g. with Playwright. Not linked from the app.
 */
export default function SubagentPanelHarness() {
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  // Terse builders for a spawn tool call (supplies label + status) and a
  // narration chunk — the shape applyFrames produces from tagged
  // agent_message/thought chunks.
  const spawn = (id: string, title: string, status: string): TimelineItem => ({
    type: "tool",
    id: `t-${id}`,
    toolCallId: id,
    kind: "subagent",
    title,
    status,
  });
  const log = (
    id: string,
    parent: string,
    variant: "message" | "thinking",
    text: string,
  ): TimelineItem => ({
    type: "subagent-log",
    id,
    parentToolCallId: parent,
    variant,
    text,
  });
  const bigLog = Array.from(
    { length: 40 },
    (_, i) =>
      `Step ${i + 1}: a long narration line, here to show a big log stays collapsed until you expand it.`,
  ).join("\n");

  // Still running + one finished (big log) + one failed: the card stays active
  // (purple), flags the failure, and the modal's blocks stay collapsed.
  const activeItems: TimelineItem[] = [
    spawn("agent1", "Agent(Explore): find the auth flow", "pending"),
    log(
      "s-1",
      "agent1",
      "thinking",
      "The login path likely lives under src/auth — let me grep for it.",
    ),
    log(
      "s-2",
      "agent1",
      "message",
      "Found the auth flow in src/auth/login.ts; it delegates to session.ts.",
    ),
    spawn("agent2", "Agent(Plan): sketch the migration", "completed"),
    log("s-3", "agent2", "message", bigLog),
    spawn("agent3", "Agent(Review): audit the diff", "failed"),
    log("s-4", "agent3", "message", "Hit an error partway through and exited."),
  ];

  // Nothing running, but one subagent failed: the card persists (red) so the
  // failure stays visible even after every subagent has terminated.
  const terminalItems: TimelineItem[] = [
    spawn("agent4", "Agent(Explore): map the routes", "completed"),
    log("s-5", "agent4", "message", "Routes live under src/app; 12 of them."),
    spawn("agent5", "Agent(Plan): draft the schema", "failed"),
    log("s-6", "agent5", "message", "Failed: could not reach the database."),
  ];

  // Every subagent finished cleanly: the card prunes itself and renders nothing.
  const allDoneItems: TimelineItem[] = [
    spawn("agent6", "Agent(Explore): find callers", "completed"),
    log("s-7", "agent6", "message", "Three callers, all in src/server."),
  ];

  const scenarios = [
    {
      testid: "panel-active",
      label: "Active — running + failed + done",
      items: activeItems,
    },
    {
      testid: "panel-terminal",
      label: "Terminal — failed + done, none running",
      items: terminalItems,
    },
    {
      testid: "panel-allok",
      label: "All succeeded — card pruned (renders nothing)",
      items: allDoneItems,
    },
  ];

  return (
    <div className="min-h-screen space-y-8 bg-[#06140c] p-4 text-white">
      <h1 className="text-lg">SubagentPanel harness</h1>
      {scenarios.map((sc) => (
        <section key={sc.testid} data-testid={sc.testid}>
          <h2 className="mb-1 text-sm text-white/50">{sc.label}</h2>
          <div className="max-w-2xl border border-white/10">
            <SubagentPanel items={sc.items} />
            <div className="p-4 text-sm text-white/40">
              …conversation below…
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
