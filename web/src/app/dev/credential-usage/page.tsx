"use client";

import { useState } from "react";

import { CredentialUsageList } from "~/app/dashboard/_components/credential-usage-indicators";

/**
 * Dev-only harness that mounts the footer's credential-usage strip in isolation
 * (no tRPC/auth), so the recently-used badges can be exercised in a real browser
 * — e.g. with Playwright. Not linked from the app. Covers a first-class provider
 * and a gollm-proxied one (the label passthrough), plus the empty state.
 */
export default function CredentialUsageHarness() {
  // Sample data pinned once at mount (lazy init keeps Date.now() out of render),
  // so the relative "used …" labels stay stable across re-renders.
  const [usage] = useState(() => {
    const now = Date.now();
    return [
      {
        provider: "anthropic",
        label: "anthropic",
        lastUsedAt: new Date(now - 3 * 60_000),
      },
      {
        provider: "gollm:groq",
        label: "Groq",
        lastUsedAt: new Date(now - 2 * 3600_000),
      },
      {
        provider: "openai",
        label: "openai",
        lastUsedAt: new Date(now - 3 * 86_400_000),
      },
    ];
  });

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  return (
    <div className="min-h-screen space-y-8 bg-[#06140c] p-8 text-white">
      <h1 className="text-lg">Credential usage harness</h1>

      <section className="space-y-2">
        <h2 className="text-sm text-white/50">Recently used</h2>
        <div className="rounded-xl border border-white/10 p-4">
          <CredentialUsageList usage={usage} />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm text-white/50">Empty (nothing used recently)</h2>
        <div
          data-testid="empty-wrapper"
          className="rounded-xl border border-white/10 p-4"
        >
          <CredentialUsageList usage={[]} />
        </div>
      </section>
    </div>
  );
}
