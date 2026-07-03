// Compact source tag shown next to each model in the picker so it's clear which
// provider it comes from. Shared by the deploy modal and the webhook config
// modal so the badges stay consistent.
const PROVIDER_TAGS: Record<string, { label: string; style: string }> = {
  anthropic: {
    label: "Anthropic",
    style: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  },
  bedrock: {
    label: "Bedrock",
    style: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  },
  openai: {
    label: "OpenAI",
    style: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  },
  gemini: {
    label: "Gemini",
    style: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  },
};

// Which credential kind serves the model. Providers with a single credential
// kind (Bedrock, Gemini) carry no auth tag.
const AUTH_TAGS: Record<string, string> = {
  api_key: "API key",
  subscription: "Subscription",
};

export function ProviderTag({
  provider,
  auth,
}: {
  provider: string;
  auth?: string;
}) {
  const tag = PROVIDER_TAGS[provider];
  if (!tag) return null;
  const authLabel = auth ? AUTH_TAGS[auth] : undefined;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {authLabel && (
        <span className="shrink-0 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60">
          {authLabel}
        </span>
      )}
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${tag.style}`}
      >
        {tag.label}
      </span>
    </span>
  );
}
