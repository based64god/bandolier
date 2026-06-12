import { describe, expect, it } from "vitest";

import { gateToken, safeFrom, timingSafeEqual } from "~/lib/gate";

describe("gateToken", () => {
  it("produces a 64-char hex SHA-256 digest", async () => {
    const token = await gateToken("hunter2", "server-secret");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same password and secret", async () => {
    const a = await gateToken("hunter2", "server-secret");
    const b = await gateToken("hunter2", "server-secret");
    expect(a).toBe(b);
  });

  it("changes when the password changes", async () => {
    const a = await gateToken("hunter2", "server-secret");
    const b = await gateToken("hunter3", "server-secret");
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes (salting)", async () => {
    const a = await gateToken("hunter2", "secret-a");
    const b = await gateToken("hunter2", "secret-b");
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for differing strings of equal length", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for strings of differing length", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("treats two empty strings as equal", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("safeFrom", () => {
  it("preserves a local absolute path", () => {
    expect(safeFrom("/dashboard")).toBe("/dashboard");
  });

  it("preserves a local path with query and fragment", () => {
    expect(safeFrom("/dashboard?tab=runs#top")).toBe("/dashboard?tab=runs#top");
  });

  it("rejects protocol-relative URLs (open-redirect)", () => {
    expect(safeFrom("//evil.com")).toBe("/");
  });

  it("rejects absolute external URLs", () => {
    expect(safeFrom("https://evil.com")).toBe("/");
  });

  it("rejects non-slash-prefixed paths", () => {
    expect(safeFrom("dashboard")).toBe("/");
  });

  it("falls back to root for null/undefined/empty", () => {
    expect(safeFrom(null)).toBe("/");
    expect(safeFrom(undefined)).toBe("/");
    expect(safeFrom("")).toBe("/");
  });
});
