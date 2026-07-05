"use client";

import { useState } from "react";

import { Conversation } from "~/app/dashboard/_components/interactive-sessions";
import type { TimelineItem } from "~/lib/acp/timeline";

/**
 * Dev-only harness that mounts the Conversation transcript in isolation (no
 * tRPC/ACP/auth), so its stick-to-bottom and awaiting re-pin behaviour can be
 * exercised in a real browser — e.g. with Playwright. Not linked from the app.
 *
 * The transcript is tall enough to overflow the scroll container so a test can
 * scroll up, then bump `scrollSignal` (via the button) and assert the view
 * snaps back to the bottom — the treatment an awaiting-input transition gives.
 */
export default function ConversationHarness() {
  const [scrollSignal, setScrollSignal] = useState(0);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const items: TimelineItem[] = Array.from({ length: 40 }, (_, i) => ({
    type: "message",
    role: i % 2 === 0 ? "user" : "assistant",
    id: `m-${i}`,
    text: `Line ${i}: the quick brown fox jumps over the lazy dog.`,
  }));

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">Conversation harness</h1>
      <button
        data-testid="await"
        onClick={() => setScrollSignal((n) => n + 1)}
        className="mb-4 rounded border border-white/15 px-3 py-1.5 text-sm"
      >
        Simulate awaiting input
      </button>
      {/* A bounded height so the transcript overflows and the inner container
          actually scrolls, mirroring the expanded session's flex column. */}
      <div className="flex h-[300px] max-w-2xl flex-col rounded-xl border border-white/10">
        <Conversation
          items={items}
          running={true}
          scrollSignal={scrollSignal}
        />
      </div>
    </div>
  );
}
