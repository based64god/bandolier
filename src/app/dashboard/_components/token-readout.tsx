import { estimateCost, formatCost, pricingForModel } from "~/lib/model-pricing";
import { formatTokens, totalTokens, type TokenUsage } from "~/lib/tokens";

/**
 * Compact token-usage readout shared by the task row, the log modal header, and
 * the interactive session card. Shows the run's total token count (abbreviated,
 * e.g. "1.2K") behind a small glyph, with the full per-category breakdown on
 * hover — plus the run's estimated cost when the model is known and priced
 * (input/output/cache each bill at their own rate). Renders nothing when the run
 * hasn't reported usage yet (or the provider doesn't report tokens), so a
 * surface without a count stays unchanged.
 */
export function TokenReadout({
  tokens,
  model,
  className = "",
}: {
  tokens: TokenUsage | null | undefined;
  /** The run's model id, used to price the usage. Omit when unknown. */
  model?: string | null;
  className?: string;
}) {
  if (!tokens) return null;
  const total = totalTokens(tokens);
  if (total <= 0) return null;

  const fmt = (n: number) => n.toLocaleString();
  const pricing = pricingForModel(model);
  const title =
    `${fmt(total)} tokens\n` +
    `input ${fmt(tokens.inputTokens)} · output ${fmt(tokens.outputTokens)}` +
    (tokens.cacheReadInputTokens > 0
      ? ` · cache read ${fmt(tokens.cacheReadInputTokens)}`
      : "") +
    (tokens.cacheCreationInputTokens > 0
      ? ` · cache write ${fmt(tokens.cacheCreationInputTokens)}`
      : "") +
    (pricing ? `\nest. cost ${formatCost(estimateCost(tokens, pricing))}` : "");

  return (
    <span
      title={title}
      aria-label={`${fmt(total)} tokens used`}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-white/40 tabular-nums ${className}`}
    >
      {/* Stacked-coins glyph — reads as a "usage" tally. */}
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
        className="h-3 w-3 shrink-0 opacity-70"
      >
        <path d="M8 2c2.76 0 5 .9 5 2s-2.24 2-5 2-5-.9-5-2 2.24-2 5-2Zm5 4.13C11.9 6.66 10.05 7 8 7s-3.9-.34-5-.87V8c0 1.1 2.24 2 5 2s5-.9 5-2V6.13Zm0 3C11.9 9.66 10.05 10 8 10s-3.9-.34-5-.87V11c0 1.1 2.24 2 5 2s5-.9 5-2V9.13Z" />
      </svg>
      {formatTokens(total)}
    </span>
  );
}
