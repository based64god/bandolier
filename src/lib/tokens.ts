// Token-usage helpers shared by the harness ingest path, the agents router, and
// the dashboard. The harness emits a `BANDOLIER_TOKENS={json}` marker line into
// the pod log / transcript (see agent-harness/cmd/harness/tokens.go); these
// helpers parse that marker, sum a run's total, and format it for display.

/** A run's token accounting. Mirrors the harness's flat tokenUsage JSON. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// Marker prefix the harness logs the usage JSON behind. This crosses the
// process boundary (the Go harness emits it, this parses it), so its value is
// pinned in wire-contract.json and asserted by both test suites — see
// src/lib/wire-contract.test.ts.
export const TOKEN_MARKER = "BANDOLIER_TOKENS=";

function toInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.floor(v)
    : 0;
}

/**
 * Parses the harness's token marker payload (the JSON after `BANDOLIER_TOKENS=`)
 * into a TokenUsage. Tolerant of missing/garbage fields — anything unparseable
 * yields null so callers can fall back to "no usage" rather than a wrong number.
 */
export function parseTokenMarkerPayload(json: string): TokenUsage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const usage: TokenUsage = {
    inputTokens: toInt(o.input_tokens),
    outputTokens: toInt(o.output_tokens),
    cacheReadInputTokens: toInt(o.cache_read_input_tokens),
    cacheCreationInputTokens: toInt(o.cache_creation_input_tokens),
  };
  return usage;
}

/**
 * Scans a transcript / log blob for the most recent token marker and returns the
 * parsed usage. The last marker wins: one-shot runs emit once, interactive runs
 * emit a growing total per turn, so the final occurrence is the run's cumulative
 * figure. Returns null when no (valid) marker is present.
 */
export function parseTokenUsageFromLogs(logs: string): TokenUsage | null {
  const idx = logs.lastIndexOf(TOKEN_MARKER);
  if (idx < 0) return null;
  let rest = logs.slice(idx + TOKEN_MARKER.length);
  const nl = rest.indexOf("\n");
  if (nl >= 0) rest = rest.slice(0, nl);
  return parseTokenMarkerPayload(rest.trim());
}

/** The grand total of every token category — what the readouts display. */
export function totalTokens(u: TokenUsage): number {
  return (
    u.inputTokens +
    u.outputTokens +
    u.cacheReadInputTokens +
    u.cacheCreationInputTokens
  );
}

/**
 * Compact human-readable token count for the dashboard: 1234 → "1.2K",
 * 1_500_000 → "1.5M". Exact below 1000. Used in the task row, log modal, and
 * interactive session card.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
}
