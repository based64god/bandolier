import { afterEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import {
  getUserOpenaiCredentials,
  isChatModel,
  listOpenaiModels,
  validateCodexAuthJson,
  validateOpenaiKey,
} from "~/server/agents/openai";

// Minimal duck-typed drizzle select chain: resolves `rows` for any query.
function fakeDb(
  rows: { apiKey: string | null; codexAuthJson: string | null }[],
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

describe("isChatModel", () => {
  it("keeps GPT chat families", () => {
    for (const id of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-5",
      "gpt-5-mini",
      "chatgpt-4o-latest",
    ]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  it("keeps the o-series reasoning models", () => {
    for (const id of [
      "o1",
      "o1-preview",
      "o1-mini",
      "o3",
      "o3-mini",
      "o4-mini",
    ]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  it("drops non-chat endpoints", () => {
    for (const id of [
      "text-embedding-3-large",
      "text-embedding-ada-002",
      "whisper-1",
      "tts-1",
      "tts-1-hd",
      "gpt-4o-audio-preview",
      "gpt-4o-realtime-preview",
      "gpt-4o-transcribe",
      "gpt-image-1",
      "dall-e-3",
      "omni-moderation-latest",
      "gpt-4o-search-preview",
      "gpt-3.5-turbo-instruct",
    ]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });

  it("drops models outside the chat families entirely", () => {
    for (const id of ["text-davinci-003", "babbage-002", "claude-sonnet-4-6"]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });

  it("is case-insensitive on the family prefix", () => {
    expect(isChatModel("GPT-4o")).toBe(true);
    expect(isChatModel("O1-Preview")).toBe(true);
  });
});

describe("validateCodexAuthJson", () => {
  it("accepts a real-shaped auth.json with ChatGPT tokens", () => {
    const raw = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id",
        access_token: "at",
        refresh_token: "rt",
        account_id: "acc",
      },
      last_refresh: "2026-07-01T00:00:00Z",
    });
    expect(validateCodexAuthJson(raw)).toEqual({ valid: true });
  });

  it("accepts tokens with only a refresh_token", () => {
    const raw = JSON.stringify({ tokens: { refresh_token: "rt" } });
    expect(validateCodexAuthJson(raw).valid).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const r = validateCodexAuthJson("not json");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/JSON/);
  });

  it("rejects non-object JSON", () => {
    expect(validateCodexAuthJson('"a string"').valid).toBe(false);
  });

  it("steers an API-key-only auth.json to the API key field", () => {
    const raw = JSON.stringify({ OPENAI_API_KEY: "sk-abc", tokens: null });
    const r = validateCodexAuthJson(raw);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/API key/);
  });

  it("rejects an object without session tokens", () => {
    const r = validateCodexAuthJson("{}");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/codex login/);
  });
});

describe("validateOpenaiKey", () => {
  it("is valid on a 200 from GET /v1/models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateOpenaiKey("sk-test")).resolves.toEqual({
      valid: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  it("maps 401 to a bad-key message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(validateOpenaiKey("sk-bad")).resolves.toEqual({
      valid: false,
      error: "API key is invalid.",
    });
  });

  it("maps other statuses to a generic API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    await expect(validateOpenaiKey("sk-test")).resolves.toEqual({
      valid: false,
      error: "OpenAI API error: 500",
    });
  });

  it("surfaces network Error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    await expect(validateOpenaiKey("sk-test")).resolves.toEqual({
      valid: false,
      error: "ECONNREFUSED",
    });
  });

  it("falls back to a generic message on non-Error failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("boom"));
    await expect(validateOpenaiKey("sk-test")).resolves.toEqual({
      valid: false,
      error: "Could not reach OpenAI API.",
    });
  });
});

describe("getUserOpenaiCredentials", () => {
  it("returns the stored credentials row", async () => {
    const db = fakeDb([{ apiKey: "sk-x", codexAuthJson: null }]);
    await expect(getUserOpenaiCredentials(db, "user-1")).resolves.toEqual({
      apiKey: "sk-x",
      codexAuthJson: null,
    });
  });

  it("returns nulls when the user has no stored credentials", async () => {
    await expect(
      getUserOpenaiCredentials(fakeDb([]), "user-1"),
    ).resolves.toEqual({ apiKey: null, codexAuthJson: null });
  });
});

describe("listOpenaiModels", () => {
  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    await expect(listOpenaiModels("sk-test")).rejects.toThrow(
      "OpenAI API 500: Internal Server Error",
    );
  });

  it("keeps only chat models, sorted by label", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "o3" },
            { id: "gpt-4o" },
            { id: "whisper-1" },
            { id: "text-embedding-3-large" },
            { id: "dall-e-3" },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // Non-chat endpoints are dropped; the survivors sort by label.
    await expect(listOpenaiModels("sk-test")).resolves.toEqual([
      { id: "gpt-4o", label: "gpt-4o" },
      { id: "o3", label: "o3" },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  it("returns an empty list for an empty data array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );
    await expect(listOpenaiModels("sk-test")).resolves.toEqual([]);
  });
});
