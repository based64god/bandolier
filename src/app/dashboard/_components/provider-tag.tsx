// The provider → accent convention in one place: the Tailwind color token, the
// badge style built from it, and the two label variants each provider is shown
// under (a compact tag in the model picker, a fuller name in the deploy badge).
// The `color` token matches the accent keys in credential-ui's ACCENTS map, so
// changing a provider's color is a single edit here.
export type ProviderColor = "purple" | "teal" | "blue" | "orange";

export const PROVIDER_ACCENT: Record<
  string,
  { color: ProviderColor; badge: string; tagLabel: string; fullLabel: string }
> = {
  anthropic: {
    color: "purple",
    badge: "border-purple-500/40 bg-purple-500/10 text-purple-300",
    tagLabel: "Anthropic",
    fullLabel: "Anthropic API",
  },
  bedrock: {
    color: "orange",
    badge: "border-orange-500/40 bg-orange-500/10 text-orange-300",
    tagLabel: "Bedrock",
    fullLabel: "AWS Bedrock",
  },
  openai: {
    color: "teal",
    badge: "border-teal-500/40 bg-teal-500/10 text-teal-300",
    tagLabel: "OpenAI",
    fullLabel: "OpenAI API",
  },
  gemini: {
    color: "blue",
    badge: "border-blue-500/40 bg-blue-500/10 text-blue-300",
    tagLabel: "Gemini",
    fullLabel: "Google Gemini",
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
  const accent = PROVIDER_ACCENT[provider];
  if (!accent) return null;
  const authLabel = auth ? AUTH_TAGS[auth] : undefined;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {authLabel && (
        <span className="shrink-0 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60">
          {authLabel}
        </span>
      )}
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${accent.badge}`}
      >
        {accent.tagLabel}
      </span>
    </span>
  );
}
