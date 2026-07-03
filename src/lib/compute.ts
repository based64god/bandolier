// ── Agent compute (CPU / memory) ───────────────────────────────────────────
//
// Agent pods run with a CPU and memory limit. Both are configurable the same
// way kubeconfigs are: a user-level default, a repo-level default (ordered by
// the repo's prefer-credentials flag), and a per-task override — from the
// deploy modal, or `cpu:<qty>` / `memory:<qty>` labels on a webhook issue.
// Values are Kubernetes resource quantities ("500m", "2", "4Gi"), validated
// here before they're stored or put on a pod so a typo'd quantity fails at
// save/deploy time with a clear message rather than as an unschedulable pod
// (or one the kernel OOM-kills instantly).

/** Per-task compute overrides/limits. Unset fields use the built-in default. */
export interface ComputeSpec {
  /** CPU limit as a Kubernetes quantity: millicores ("500m") or cores ("2"). */
  cpu?: string;
  /** Memory limit as a Kubernetes quantity, e.g. "512Mi", "4Gi". */
  memory?: string;
}

/** Built-in limits applied when neither the task, repo, nor user sets one. */
export const DEFAULT_CPU_LIMIT = "2";
export const DEFAULT_MEMORY_LIMIT = "2Gi";

// Bounds on what a single agent pod may claim. The ceilings bound typos and
// abuse (a "memory:2000Gi" label must not park an unschedulable pod or eat the
// cluster); the memory floor catches unit mistakes like "4M" or "64Mi" — no
// harness run survives under 128Mi. (A bare number like "4" is not a mistake:
// validateMemoryQuantity reads it as Gi.)
const MAX_CPU_MILLIS = 64_000; // 64 cores
const MIN_MEMORY_BYTES = 128 * 1024 ** 2; // 128Mi
const MAX_MEMORY_BYTES = 512 * 1024 ** 3; // 512Gi

/**
 * Parses a CPU quantity ("500m" millicores, or "2" / "1.5" cores) to
 * millicores. Null when the string isn't a valid CPU quantity.
 */
export function cpuToMillicores(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "m" ? n : n * 1000;
}

const MEMORY_UNIT_BYTES: Record<string, number> = {
  "": 1,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/**
 * Parses a memory quantity ("512Mi", "4Gi", "1.5G", plain bytes) to bytes.
 * Null when the string isn't a valid memory quantity. Supports the K/M/G/T
 * decimal and Ki/Mi/Gi/Ti binary suffixes — the ones humans actually use.
 */
export function memoryToBytes(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([KMGT]i?)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n * MEMORY_UNIT_BYTES[m[2] ?? ""]!;
}

export type QuantityValidation =
  | { valid: true; normalized: string }
  | { valid: false; error: string };

/**
 * Validates a CPU limit. Returns the normalized (trimmed) quantity to store,
 * or a human-readable error for the settings/deploy UI.
 */
export function validateCpuQuantity(value: string): QuantityValidation {
  const normalized = value.trim();
  const millis = cpuToMillicores(normalized);
  if (millis === null) {
    return {
      valid: false,
      error: `Invalid CPU quantity "${normalized}" — use millicores ("500m") or cores ("2").`,
    };
  }
  if (millis <= 0 || millis > MAX_CPU_MILLIS) {
    return {
      valid: false,
      error: `CPU must be between 1m and ${MAX_CPU_MILLIS / 1000} cores.`,
    };
  }
  return { valid: true, normalized };
}

/**
 * Validates a memory limit. Returns the normalized quantity to store, or a
 * human-readable error for the settings/deploy UI. A bare number defaults to
 * Gi ("4" -> "4Gi"), matching the unit humans mean for a memory limit.
 */
export function validateMemoryQuantity(value: string): QuantityValidation {
  const trimmed = value.trim();
  // A bare number carries no unit; treat it as Gi — the unit humans mean when
  // they type "4" for a memory limit — rather than 4 bytes. Anything with an
  // explicit suffix is left as-is (so "4M" / "64Mi" still fail the floor).
  const normalized = /^\d+(?:\.\d+)?$/.test(trimmed) ? `${trimmed}Gi` : trimmed;
  const bytes = memoryToBytes(normalized);
  if (bytes === null) {
    return {
      valid: false,
      error: `Invalid memory quantity "${trimmed}" — use a Kubernetes quantity like "512Mi" or "4Gi".`,
    };
  }
  if (bytes < MIN_MEMORY_BYTES || bytes > MAX_MEMORY_BYTES) {
    return {
      valid: false,
      error: "Memory must be between 128Mi and 512Gi.",
    };
  }
  return { valid: true, normalized };
}

/**
 * Resolves a free-text CPU query (e.g. from a `cpu:<qty>` issue label) to a
 * valid quantity, or undefined when it doesn't parse — callers fall back to
 * their default, mirroring parseEffortQuery.
 */
export function parseCpuQuery(query: string): string | undefined {
  const v = validateCpuQuantity(query);
  return v.valid ? v.normalized : undefined;
}

/** Memory counterpart of parseCpuQuery, for `memory:<qty>` issue labels. */
export function parseMemoryQuery(query: string): string | undefined {
  const v = validateMemoryQuantity(query);
  return v.valid ? v.normalized : undefined;
}
