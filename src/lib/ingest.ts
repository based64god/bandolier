import crypto from "crypto";

/**
 * A stateless per-job token the harness presents when uploading run artifacts.
 * It's an HMAC of the job name with the server secret, so the ingest endpoint
 * can verify it without storing anything, and it can't be forged.
 */
export function ingestToken(jobName: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`bandolier-ingest:${jobName}`)
    .digest("hex");
}

export function verifyIngestToken(
  jobName: string,
  token: string,
  secret: string,
): boolean {
  const expected = ingestToken(jobName, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
