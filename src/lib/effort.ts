import type { ModelProvider } from "~/server/agents/models";

// ── Reasoning effort ───────────────────────────────────────────────────────
//
// Every run is driven by the `claude` CLI, which accepts a reasoning-effort
// level (--effort): how much the model thinks and acts before answering.
// Higher effort trades latency and tokens for thoroughness. For non-Anthropic
// providers the harness's embedded gollm proxy maps the resulting thinking
// budget onto the backend's reasoning knob (e.g. OpenAI reasoning_effort), so
// the picker applies to all providers.

/**
 * The effort levels the `claude` CLI accepts for `--effort`, lowest to highest.
 * This is a wire value shared with the harness's allow-list, so it's pinned in
 * wire-contract.json and asserted by both test suites — see
 * src/lib/wire-contract.test.ts. Also matches the CLI itself.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrows an arbitrary string to a known effort level. */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Whether a provider supports the reasoning-effort flag. All of them do now
 * that every run is driven by the `claude` CLI (the embedded proxy translates
 * the thinking budget for non-Anthropic backends); the signature stays so a
 * future provider without a reasoning knob can opt out in one place.
 */
export function providerSupportsEffort(_provider: ModelProvider): boolean {
  return true;
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
