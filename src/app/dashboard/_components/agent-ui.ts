// Shared presentation helpers for agent tables (per-repo view + overview panel).

export const STATUS_STYLES: Record<string, string> = {
  Running: "border-green-500/40 bg-green-500/20 text-green-300",
  Pending: "border-yellow-500/40 bg-yellow-500/20 text-yellow-300",
  Failed: "border-red-500/40 bg-red-500/20 text-red-300",
  Succeeded: "border-blue-500/40 bg-blue-500/20 text-blue-300",
  Unknown: "border-gray-500/40 bg-gray-500/20 text-gray-400",
};

// Single-path glyphs (Heroicons mini, 20×20 viewBox, fill-rule evenodd) that
// mirror each status. They let the status pill collapse from text to comparable
// iconography when horizontal space is tight (e.g. narrow/mobile viewports),
// where the pill colour already carries most of the meaning.
export const STATUS_ICON_PATHS: Record<string, string> = {
  // Solid disc — an active, in-flight agent.
  Running: "M10 2a8 8 0 100 16 8 8 0 000-16z",
  // Clock — queued, not yet started.
  Pending:
    "M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z",
  // X in a circle — errored out.
  Failed:
    "M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z",
  // Check in a circle — finished cleanly.
  Succeeded:
    "M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z",
  // Minus in a circle — indeterminate.
  Unknown:
    "M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z",
};

// Terminal pod phases — the agent has finished and won't change further.
const DONE_STATUSES = new Set(["Succeeded", "Failed"]);

/** Whether an agent has finished running (so it can sink to the bottom). */
export function isAgentDone(status: string): boolean {
  return DONE_STATUSES.has(status);
}

// Time left until the finished job is garbage-collected. Null/running → "—".
export function expiresIn(expiresAt: string | null): string {
  if (!expiresAt) return "—";
  const secs = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (secs <= 0) return "expiring…";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
