import type { ModelProvider } from "~/server/agents/models";

// ── Reasoning effort ───────────────────────────────────────────────────────
//
// Claude models accept a reasoning-effort level (the `claude` CLI's --effort
// flag): how much the model thinks and acts before answering. Higher effort
// trades latency and tokens for thoroughness. Effort only applies to the Claude
// providers (Anthropic API, AWS Bedrock) — the OpenAI (Codex) and Gemini
// (Antigravity) CLIs don't take it, so the picker is hidden for those and the
// value is never forwarded to their jobs.

/**
 * The effort levels the `claude` CLI accepts for `--effort`, lowest to highest.
 * Kept in sync with the harness's allow-list (agent-harness/cmd/harness/main.go)
 * and the CLI itself.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrows an arbitrary string to a known effort level. */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Whether a provider's CLI supports the reasoning-effort flag. Only the Claude
 * side does — Bedrock and the Anthropic API both run the `claude` CLI. OpenAI
 * (Codex) and Gemini (Antigravity) ignore it, so callers must not surface the
 * picker or forward a value for them.
 */
export function providerSupportsEffort(provider: ModelProvider): boolean {
  return provider === "anthropic" || provider === "bedrock";
}

/**
 * Resolves a free-text effort query (e.g. from an `effort:<query>` issue label)
 * to a concrete level. Matches case-insensitively against the known levels;
 * returns undefined when nothing matches so callers fall back to their default.
 */
export function parseEffortQuery(query: string): EffortLevel | undefined {
  const q = query.trim().toLowerCase();
  return isEffortLevel(q) ? q : undefined;
}
