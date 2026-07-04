// Per-model token pricing, used to turn a run's TokenUsage into an estimated
// dollar cost in the dashboard's token readout. Rates are USD per million tokens
// and mirror Anthropic's published Claude pricing; cache reads bill at 0.1× the
// input rate and 5-minute cache writes at 1.25×, matching the API's cache
// economics. A model we don't recognise yields null so callers can fall back to
// showing the raw token count with no cost line.

import type { TokenUsage } from "./tokens";

/** USD-per-million-token rates for each token category the harness reports. */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

/** Builds a Claude-family pricing entry from its input/output rates, deriving
 * cache read (0.1×) and 5-minute cache write (1.25×) from the input rate. */
function claude(inputPer1M: number, outputPer1M: number): ModelPricing {
  return {
    inputPer1M,
    outputPer1M,
    cacheReadPer1M: inputPer1M * 0.1,
    cacheWritePer1M: inputPer1M * 1.25,
  };
}

// Matched in order against the normalised model id; the first hit wins. Keyed by
// family substring so a specific version (e.g. `claude-opus-4-8`) or a Bedrock
// inference-profile id (e.g. `us.anthropic.claude-sonnet-...`) both resolve.
const CLAUDE_FAMILIES: { match: RegExp; pricing: ModelPricing }[] = [
  { match: /fable/, pricing: claude(10, 50) },
  { match: /opus/, pricing: claude(5, 25) },
  { match: /sonnet/, pricing: claude(3, 15) },
  { match: /haiku/, pricing: claude(1, 5) },
];

/**
 * Resolves the per-token pricing for a model id, or null when the model is
 * unknown (non-Claude providers, or a Claude family we haven't priced). Tolerant
 * of Bedrock cross-region prefixes (`us.`, `eu.anthropic.…`) and Vertex `@date`
 * suffixes since the id can arrive in any of those shapes.
 */
export function pricingForModel(
  model: string | null | undefined,
): ModelPricing | null {
  if (!model) return null;
  const id = model.toLowerCase();
  for (const { match, pricing } of CLAUDE_FAMILIES) {
    if (match.test(id)) return pricing;
  }
  return null;
}

/** Estimated USD cost of a run's usage under the given pricing. */
export function estimateCost(
  tokens: TokenUsage,
  pricing: ModelPricing,
): number {
  return (
    (tokens.inputTokens / 1_000_000) * pricing.inputPer1M +
    (tokens.outputTokens / 1_000_000) * pricing.outputPer1M +
    (tokens.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPer1M +
    (tokens.cacheCreationInputTokens / 1_000_000) * pricing.cacheWritePer1M
  );
}

/**
 * Formats an estimated cost for the readout tooltip: exact cents down to
 * "$0.01", a "<$0.01" floor for tiny-but-nonzero runs, and whole-dollar
 * precision (no cents) once the figure reaches $100.
 */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd >= 100) return `$${Math.round(usd).toLocaleString()}`;
  return `$${usd.toFixed(2)}`;
}
