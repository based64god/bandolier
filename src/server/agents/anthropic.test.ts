import { afterEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import {
  getUserAnthropicCredentials,
  validateAnthropicKey,
  validateAnthropicOauthToken,
} from "~/server/agents/anthropic";

// Minimal duck-typed drizzle select chain: resolves `rows` for any query.
function fakeDb(
  rows: { apiKey: string | null; oauthToken: string | null }[],
): typeof Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  } as unknown as typeof Database;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateAnthropicKey", () => {
  it("is valid on a 200 from GET /v1/models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateAnthropicKey("sk-ant-test")).resolves.toEqual({
      valid: true,
    });

    // A cheap, token-free probe: one model, key + version headers.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("maps 401 to a bad-key message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(validateAnthropicKey("sk-ant-bad")).resolves.toEqual({
      valid: false,
      error: "API key is invalid.",
    });
  });

  it("maps other statuses to a generic API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 529 }),
    );
    await expect(validateAnthropicKey("sk-ant-test")).resolves.toEqual({
      valid: false,
      error: "Anthropic API error: 529",
    });
  });

  it("surfaces network Error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("socket hang up")),
    );
    await expect(validateAnthropicKey("sk-ant-test")).resolves.toEqual({
      valid: false,
      error: "socket hang up",
    });
  });

  it("falls back to a generic message on non-Error failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("boom"));
    await expect(validateAnthropicKey("sk-ant-test")).resolves.toEqual({
      valid: false,
      error: "Could not reach Anthropic API.",
    });
  });
});

describe("validateAnthropicOauthToken", () => {
  it("accepts a setup-token-shaped OAuth token", () => {
    expect(
      validateAnthropicOauthToken(`sk-ant-oat01-${"a".repeat(40)}`),
    ).toEqual({ valid: true });
  });

  it("accepts a token at the minimum length boundary", () => {
    // Exactly 20 chars after the prefix — the shortest non-truncated token.
    expect(validateAnthropicOauthToken(`sk-ant-oat${"a".repeat(20)}`)).toEqual({
      valid: true,
    });
  });

  it("rejects an Anthropic API key pasted in the OAuth field", () => {
    const r = validateAnthropicOauthToken(`sk-ant-api03-${"a".repeat(40)}`);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/setup-token/);
  });

  it("rejects arbitrary strings", () => {
    expect(validateAnthropicOauthToken("hello").valid).toBe(false);
  });

  it("rejects a truncated token", () => {
    const r = validateAnthropicOauthToken("sk-ant-oat01-abc");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/truncated/);
  });
});

describe("getUserAnthropicCredentials", () => {
  it("returns the stored credentials row", async () => {
    const db = fakeDb([{ apiKey: null, oauthToken: "sk-ant-oat01-x" }]);
    await expect(getUserAnthropicCredentials(db, "user-1")).resolves.toEqual({
      apiKey: null,
      oauthToken: "sk-ant-oat01-x",
    });
  });

  it("returns nulls when the user has no stored credentials", async () => {
    await expect(
      getUserAnthropicCredentials(fakeDb([]), "user-1"),
    ).resolves.toEqual({ apiKey: null, oauthToken: null });
  });
});
