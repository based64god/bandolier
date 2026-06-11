// Shared-password gate, layered in front of the whole app. Helpers here are
// edge-safe (Web Crypto + TextEncoder only) so they work in middleware and in
// the Node route handler alike.

export const GATE_COOKIE = "bandolier_gate";

/**
 * Derives the opaque cookie token that proves knowledge of the gate password.
 * It's a hash of the password (salted with the auth secret), so the raw
 * password is never stored in the cookie and the token can't be forged without
 * knowing the password.
 */
export async function gateToken(
  password: string,
  secret: string,
): Promise<string> {
  const data = new TextEncoder().encode(`bandolier-gate:${secret}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison of two equal-length hex strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Restricts a post-gate redirect target to a local path, preventing the gate
 * from being used as an open redirect.
 */
export function safeFrom(from: string | null | undefined): string {
  if (from && from.startsWith("/") && !from.startsWith("//")) return from;
  return "/";
}
