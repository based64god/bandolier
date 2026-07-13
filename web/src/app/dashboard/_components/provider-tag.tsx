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

// gollm-proxied providers all share one accent; their per-provider label comes
// from the catalog, passed in as `label` (the picker knows it). This keeps the
// tag component from importing the ~100-entry catalog into the client bundle.
const GOLLM_BADGE = "border-sky-500/40 bg-sky-500/10 text-sky-300";

export function ProviderTag({
  provider,
  auth,
  label,
}: {
  provider: string;
  auth?: string;
  /** Display label for a gollm-proxied provider (`gollm:<id>`). */
  label?: string;
}) {
  const authLabel = auth ? AUTH_TAGS[auth] : undefined;

  // gollm-proxied provider: one shared accent, catalog label (or the bare id).
  const gollmId = provider.startsWith("gollm:")
    ? provider.slice("gollm:".length)
    : null;
  const accent = PROVIDER_ACCENT[provider];
  if (!accent && !gollmId) return null;

  const badge = accent?.badge ?? GOLLM_BADGE;
  const tagLabel = accent?.tagLabel ?? label ?? gollmId ?? provider;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {authLabel && (
        <span className="shrink-0 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60">
          {authLabel}
        </span>
      )}
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${badge}`}
      >
        {tagLabel}
      </span>
    </span>
  );
}
