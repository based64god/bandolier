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

  // A spawn tool call (supplies the label) plus that subagent's narration, the
  // shape applyFrames produces from tagged agent_message/thought chunks.
  const items: TimelineItem[] = [
    {
      type: "tool",
      id: "t-agent",
      toolCallId: "agent1",
      kind: "subagent",
      title: "Agent(Explore): find the auth flow",
      status: "completed",
    },
    {
      type: "subagent-log",
      id: "s-1",
      parentToolCallId: "agent1",
      variant: "thinking",
      text: "The login path likely lives under src/auth — let me grep for it.",
    },
    {
      type: "subagent-log",
      id: "s-2",
      parentToolCallId: "agent1",
      variant: "message",
      text: "Found the auth flow in src/auth/login.ts; it delegates to session.ts.",
    },
  ];

  return (
    <div className="min-h-screen bg-[#06140c] text-white">
      <h1 className="p-4 text-lg">SubagentPanel harness</h1>
      <div className="max-w-2xl border border-white/10">
        <SubagentPanel items={items} />
        <div className="p-4 text-sm text-white/40">…conversation below…</div>
      </div>
    </div>
  );
}
