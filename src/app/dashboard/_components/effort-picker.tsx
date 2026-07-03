"use client";

import { EFFORT_LEVELS } from "~/lib/effort";

// ── Effort picker ──────────────────────────────────────────────────────────
//
// A segmented control for the reasoning-effort level ("default" + the Claude
// CLI levels), with an optional "Preferred" toggle that pins the dashboard
// default. Rendered only for Claude models (the caller gates on
// providerSupportsEffort); the OpenAI/Gemini CLIs don't take an effort flag.
// Kept as a standalone component so it can be previewed in isolation (see
// /dev/effort-picker) and reused wherever effort is chosen.

export function EffortPicker({
  value,
  onChange,
  preferred,
  isPreferred,
  onTogglePreferred,
}: {
  /** The effective level; "" means the CLI default. */
  value: string;
  onChange: (value: string) => void;
  /** Whether to show the "Preferred" pin toggle (dashboard deploys). */
  preferred?: boolean;
  isPreferred?: boolean;
  onTogglePreferred?: (next: boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-white/60">
        Reasoning effort
      </label>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-1.5">
          {(["", ...EFFORT_LEVELS] as const).map((level) => {
            const active = value === level;
            return (
              <button
                key={level || "default"}
                type="button"
                onClick={() => onChange(level)}
                className={`min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-xs capitalize transition ${
                  active
                    ? "border-purple-500/50 bg-purple-500/15 text-white"
                    : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                }`}
              >
                {level || "default"}
              </button>
            );
          })}
        </div>
        {preferred && (
          <label
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs transition ${
              isPreferred
                ? "border-purple-500/50 bg-purple-500/15 text-white"
                : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
            } ${!value ? "cursor-not-allowed opacity-40" : ""}`}
            title="Use this effort as the default when deploying from the dashboard. Doesn't affect webhook-triggered tasks."
          >
            <input
              type="checkbox"
              checked={!!isPreferred}
              disabled={!value}
              onChange={(e) => onTogglePreferred?.(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-purple-600"
            />
            Preferred
          </label>
        )}
      </div>
      <p className="text-xs text-white/40">
        How much Claude thinks before acting. Higher effort is more thorough but
        slower and costlier. &ldquo;Default&rdquo; leaves it to the model.
      </p>
    </div>
  );
}
