"use client";

import { TokenReadout } from "~/app/dashboard/_components/token-readout";

/**
 * Dev-only harness that mounts TokenReadout in isolation (no tRPC/auth), so the
 * token-usage chip can be exercised in a real browser — e.g. with Playwright.
 * Not linked from the app.
 */
export default function TokensHarness() {
  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const cases: {
    label: string;
    tokens: Parameters<typeof TokenReadout>[0]["tokens"];
  }[] = [
    { label: "null (renders nothing)", tokens: null },
    {
      label: "zero (renders nothing)",
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    {
      label: "small",
      tokens: {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    {
      label: "thousands",
      tokens: {
        inputTokens: 4200,
        outputTokens: 1800,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 300,
      },
    },
    {
      label: "millions",
      tokens: {
        inputTokens: 1_200_000,
        outputTokens: 450_000,
        cacheReadInputTokens: 80_000,
        cacheCreationInputTokens: 20_000,
      },
    },
  ];

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">TokenReadout harness</h1>
      <ul className="space-y-3">
        {cases.map((c) => (
          <li key={c.label} className="flex items-center gap-4">
            <span className="w-56 text-sm text-white/50">{c.label}</span>
            <span data-testid={`readout-${c.label.split(" ")[0]}`}>
              <TokenReadout tokens={c.tokens} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
