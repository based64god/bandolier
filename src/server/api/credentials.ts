import { z } from "zod";

/**
 * Masks a secret for display: keeps the first and last 4 characters and elides
 * the middle. Short values (≤8 chars) are returned as-is since there's nothing
 * to hide. Never send the raw secret to the client — only its mask.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// Single-line secrets pasted from a wrapped terminal line carry interior
// spaces/newlines that survive trim(); real single-token keys never contain
// whitespace, so it's always safe to strip. (Not for structured credentials
// like a service-account JSON, whose PEM private key contains real spaces.)
export const stripWhitespace = z
  .string()
  .transform((s) => s.replace(/\s+/g, ""));
