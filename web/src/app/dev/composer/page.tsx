"use client";

import { useState } from "react";

import { SessionComposer } from "~/app/dashboard/_components/session-composer";

/**
 * Dev-only harness that mounts SessionComposer in isolation (no tRPC/ACP/auth),
 * so the slash-command UX can be exercised in a real browser — e.g. with
 * Playwright. Not linked from the app. The sent messages are echoed below so a
 * test can assert what would be dispatched.
 *
 * Query params tune the scenario: `?commands=a,b,c` advertises a live command
 * list (mirroring an ACP available_commands_update); omit it to test the
 * curated-default fallback.
 */
export default function ComposerHarness() {
  const [sent, setSent] = useState<string[]>([]);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const params =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search);
  const commandsParam = params?.get("commands");
  const commands = commandsParam
    ? commandsParam
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ name }))
    : [];

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">SessionComposer harness</h1>
      <div className="max-w-2xl rounded-xl border border-white/10">
        <SessionComposer
          running
          awaiting={false}
          ready
          sendPending={false}
          sendError={null}
          commands={commands}
          onSend={(content) => setSent((s) => [...s, content])}
        />
      </div>
      <ul data-testid="sent" className="mt-4 space-y-1 font-mono text-sm">
        {sent.map((m, i) => (
          <li key={i} data-testid="sent-item">
            {m}
          </li>
        ))}
      </ul>
    </div>
  );
}
