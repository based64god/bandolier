import crypto from "crypto";

import { ingestToken } from "~/lib/ingest";

// Real auth material so integration tests drive the actual verification code in
// the route handlers instead of mocking it. The signing key must match what the
// handler verifies against — BETTER_AUTH_SECRET / GITHUB_WEBHOOK_SECRET from the
// integration env block (vitest.integration.config.ts).

// signWebhook reproduces the GitHub webhook signature header
// (X-Hub-Signature-256) the way src/app/api/webhooks/github/route.ts verifies
// it: "sha256=" + HMAC-SHA256(rawBody, secret).
export function signWebhook(rawBody: string, secret: string): string {
  const mac = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${mac}`;
}

// bearerIngestToken re-exports the PRODUCTION ingest token derivation so the
// harness-callback route handlers accept it. Hand-rolling an HMAC of the bare
// job name would fail — the real token keys on `bandolier-ingest:${jobName}`.
export function bearerIngestToken(jobName: string, secret: string): string {
  return `Bearer ${ingestToken(jobName, secret)}`;
}
