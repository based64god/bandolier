import crypto from "crypto";

/**
 * A stateless per-job token the harness presents when uploading run artifacts.
 * It's an HMAC of the job name with the server secret, so the ingest endpoint
 * can verify it without storing anything, and it can't be forged.
 *
 * When no secret is configured this returns an empty string rather than keying
 * the HMAC with `""` — so an un-set secret yields an unusable token that fails
 * verification (fail closed), instead of a publicly-computable, forgeable one.
 */
export function ingestToken(
  jobName: string,
  secret: string | undefined,
): string {
  if (!secret) return "";
  return crypto
    .createHmac("sha256", secret)
    .update(`bandolier-ingest:${jobName}`)
    .digest("hex");
}

export function verifyIngestToken(
  jobName: string,
  token: string,
  secret: string | undefined,
): boolean {
  // No secret → no valid token can exist; reject rather than accepting a token
  // forged against an empty key.
  if (!secret || !token) return false;
  const expected = ingestToken(jobName, secret);
  if (!expected) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
