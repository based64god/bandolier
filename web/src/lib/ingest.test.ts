import { describe, expect, it } from "vitest";

import { ingestToken, verifyIngestToken } from "~/lib/ingest";

describe("ingestToken", () => {
  it("produces a 64-char hex HMAC digest", () => {
    expect(ingestToken("job-abc", "secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same job and secret", () => {
    expect(ingestToken("job-abc", "secret")).toBe(
      ingestToken("job-abc", "secret"),
    );
  });

  it("differs per job name", () => {
    expect(ingestToken("job-abc", "secret")).not.toBe(
      ingestToken("job-xyz", "secret"),
    );
  });

  it("differs per secret", () => {
    expect(ingestToken("job-abc", "secret-a")).not.toBe(
      ingestToken("job-abc", "secret-b"),
    );
  });

  it("returns an empty (unusable) token when no secret is configured", () => {
    // Fail closed: an unset secret must not yield a publicly-computable token.
    expect(ingestToken("job-abc", undefined)).toBe("");
    expect(ingestToken("job-abc", "")).toBe("");
  });
});

describe("verifyIngestToken", () => {
  it("accepts a token it produced", () => {
    const token = ingestToken("job-abc", "secret");
    expect(verifyIngestToken("job-abc", token, "secret")).toBe(true);
  });

  it("rejects a token for a different job", () => {
    const token = ingestToken("job-abc", "secret");
    expect(verifyIngestToken("job-xyz", token, "secret")).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = ingestToken("job-abc", "other-secret");
    expect(verifyIngestToken("job-abc", token, "secret")).toBe(false);
  });

  it("rejects a malformed token without throwing (length mismatch)", () => {
    expect(verifyIngestToken("job-abc", "deadbeef", "secret")).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(verifyIngestToken("job-abc", "", "secret")).toBe(false);
  });

  it("rejects any token when no secret is configured", () => {
    // No secret → no valid token can exist, even if the caller supplies one
    // that was computed against an empty key.
    const forged = ingestToken("job-abc", "");
    expect(verifyIngestToken("job-abc", forged, undefined)).toBe(false);
    expect(verifyIngestToken("job-abc", "anything", undefined)).toBe(false);
    expect(verifyIngestToken("job-abc", "anything", "")).toBe(false);
  });
});
