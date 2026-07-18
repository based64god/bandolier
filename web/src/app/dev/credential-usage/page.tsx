"use client";

import { useState } from "react";

import {
  type CredentialUsage,
  CredentialUsageList,
} from "~/app/dashboard/_components/credential-usage-indicators";

/**
 * Dev-only harness that mounts the footer's credential-usage strip in isolation
 * (no tRPC/auth), so the badges can be exercised in a real browser — e.g. with
 * Playwright. Not linked from the app. Covers a metered API key (the "used …"
 * timestamp), a gollm-proxied one (the label passthrough), and a subscription
 * (the "how close to maxed out" meter), plus the empty state.
 */
export default function CredentialUsageHarness() {
  // Sample data pinned once at mount (lazy init keeps Date.now() out of render),
  // so the relative labels and meters stay stable across re-renders.
  const [usage] = useState<CredentialUsage[]>(() => {
    const now = Date.now();
    return [
      {
        provider: "anthropic",
        label: "anthropic",
        authKind: "subscription",
        lastUsedAt: new Date(now - 3 * 60_000),
        // 20 of 25 runs → a near-maxed (red) meter that resets soon.
        usage: {
          runs: 20,
          budget: 25,
          resetsAt: new Date(now + 40 * 60_000),
        },
      },
      {
        provider: "openai",
        label: "openai",
        authKind: "subscription",
        lastUsedAt: new Date(now - 30 * 60_000),
        // 8 of 25 runs → a comfortable (green) meter.
        usage: {
          runs: 8,
          budget: 25,
          resetsAt: new Date(now + 3 * 3600_000),
        },
      },
      {
        provider: "gollm:groq",
        label: "Groq",
        authKind: "api_key",
        lastUsedAt: new Date(now - 2 * 3600_000),
        usage: null,
      },
      {
        provider: "bedrock",
        label: "bedrock",
        authKind: "api_key",
        lastUsedAt: new Date(now - 3 * 86_400_000),
        usage: null,
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
