"use client";

import {
  ProviderDirectory,
  type ProviderEntry,
} from "~/app/dashboard/_components/provider-directory";

/**
 * Dev-only harness that mounts the shared ProviderDirectory accordion in
 * isolation (no tRPC/auth), so the credential "shape hint" — the concise
 * subtitle shown under a provider's label in the collapsed row — can be
 * exercised in a real browser, e.g. with Playwright. Not linked from the app.
 * Entries mirror real usage: some carry a hint, one omits it to prove the
 * subtitle is optional.
 */
export default function ProviderDirectoryHarness() {
  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const entries: ProviderEntry[] = [
    {
      id: "anthropic",
      label: "Anthropic",
      accent: "purple",
      configured: true,
      hint: "API key (sk-ant-…) or Claude subscription",
      body: <p data-testid="anthropic-body">Anthropic credential form</p>,
    },
    {
      id: "bedrock",
      label: "AWS Bedrock",
      accent: "orange",
      configured: false,
      hint: "Access key + secret + region",
      body: <p data-testid="bedrock-body">Bedrock credential form</p>,
    },
    {
      id: "plain",
      label: "No-hint provider",
      accent: "sky",
      configured: false,
      body: <p data-testid="plain-body">Plain credential form</p>,
    },
  ];

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">ProviderDirectory harness</h1>
      <div className="max-w-lg">
        <ProviderDirectory entries={entries} />
      </div>
    </div>
  );
}
