// Shared presentation helpers for agent tables (per-repo view + overview panel).

export const STATUS_STYLES: Record<string, string> = {
  Running: "border-green-500/40 bg-green-500/20 text-green-300",
  Pending: "border-yellow-500/40 bg-yellow-500/20 text-yellow-300",
  Failed: "border-red-500/40 bg-red-500/20 text-red-300",
  Succeeded: "border-blue-500/40 bg-blue-500/20 text-blue-300",
  Unknown: "border-gray-500/40 bg-gray-500/20 text-gray-400",
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
