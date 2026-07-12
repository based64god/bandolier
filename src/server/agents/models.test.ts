import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { friendlyAwsError } from "~/server/agents/aws";
import type { CustomProviderCredential } from "~/server/agents/custom-providers";
import {
  fuzzyPickModel,
  listModelsForUser,
  pickDefaultModel,
  pickLatestGeminiFlash,
  pickLatestGptMini,
  pickLatestSonnet,
  pickPrWriterModel,
  type ModelOption,
} from "~/server/agents/models";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";
import type { db as Database } from "~/server/db";

// The gollm custom-providers branch of listModelsForUser fans out to the
// per-provider model fetcher, so mock the two boundaries it crosses — credential
// resolution and the custom-provider listing — to drive the loop hermetically.
// The pure pickers/error-mapping tests below use no mocks and are unaffected
// (they don't touch either mocked module). vi.mock is hoisted above the imports;
// the deferred arrows dodge the const-before-init TDZ.
const resolveModelCredentials =
  vi.fn<
    (
      database: unknown,
      userId: string,
      repoFullName?: string,
    ) => Promise<ModelCredentials>
  >();
const listCustomProviderModels =
  vi.fn<
    (cred: CustomProviderCredential) => Promise<{ id: string; label: string }[]>
  >();

vi.mock("~/server/agents/resolve-credentials", () => ({
  resolveModelCredentials: (
    database: unknown,
    userId: string,
    repoFullName?: string,
  ) => resolveModelCredentials(database, userId, repoFullName),
}));
// gollmProviderName is a pure `gollm:<id>` tag — reimplement it rather than stub
// it away, so the provider labels the tests assert against are the real ones.
vi.mock("~/server/agents/custom-providers", () => ({
  listCustomProviderModels: (cred: CustomProviderCredential) =>
    listCustomProviderModels(cred),
  gollmProviderName: (id: string) => `gollm:${id}` as const,
}));

const m = (id: string, label = id): ModelOption => ({
  id,
  label,
  provider: "anthropic",
});

const openai = (id: string): ModelOption => ({
  id,
  label: id,
  provider: "openai",
});

const gemini = (id: string): ModelOption => ({
  id,
  label: id,
  provider: "gemini",
});

describe("pickDefaultModel", () => {
  it("returns undefined for an empty list", () => {
    expect(pickDefaultModel([])).toBeUndefined();
  });

  it("prefers a Sonnet model when present", () => {
    const models = [m("claude-opus-4-8"), m("claude-sonnet-4-6")];
    expect(pickDefaultModel(models)).toBe("claude-sonnet-4-6");
  });

  it("matches Sonnet by label when the id does not contain it", () => {
    const models = [m("model-a"), m("model-b", "Claude Sonnet 4.6")];
    expect(pickDefaultModel(models)).toBe("model-b");
  });

  it("falls back to the first model when no Sonnet is present", () => {
    const models = [m("claude-opus-4-8"), m("claude-haiku-4-5")];
    expect(pickDefaultModel(models)).toBe("claude-opus-4-8");
  });
});

describe("pickLatestSonnet", () => {
  it("returns undefined when no Sonnet model exists", () => {
    expect(pickLatestSonnet([m("claude-opus-4-8")])).toBeUndefined();
  });

  it("picks the highest version among Sonnet ids", () => {
    const models = [
      m("claude-3-5-sonnet-20241022"),
      m("claude-sonnet-4-6"),
      m("claude-3-7-sonnet"),
    ];
    expect(pickLatestSonnet(models)).toBe("claude-sonnet-4-6");
  });

  it("compares version tokens left to right", () => {
    const models = [m("claude-sonnet-4-5"), m("claude-sonnet-4-6")];
    expect(pickLatestSonnet(models)).toBe("claude-sonnet-4-6");
  });

  it("works across Bedrock inference-profile ids", () => {
    const models = [
      m("us.anthropic.claude-3-5-sonnet-20241022-v2:0"),
      m("us.anthropic.claude-sonnet-4-6-20250101-v1:0"),
    ];
    expect(pickLatestSonnet(models)).toBe(
      "us.anthropic.claude-sonnet-4-6-20250101-v1:0",
    );
  });

  it("ignores non-Sonnet models when choosing the latest", () => {
    const models = [m("claude-opus-9-9"), m("claude-sonnet-4-6")];
    expect(pickLatestSonnet(models)).toBe("claude-sonnet-4-6");
  });
});

describe("pickLatestGptMini", () => {
  it("returns undefined when no GPT mini model exists", () => {
    expect(
      pickLatestGptMini([openai("gpt-5"), m("claude-sonnet-4-6")]),
    ).toBeUndefined();
  });

  it("picks the highest-version GPT mini", () => {
    const models = [
      openai("gpt-4o-mini"),
      openai("gpt-4.1-mini"),
      openai("gpt-5-mini"),
    ];
    expect(pickLatestGptMini(models)).toBe("gpt-5-mini");
  });

  it("ignores non-mini and non-OpenAI models", () => {
    const models = [
      openai("gpt-5"),
      m("claude-3-5-haiku"),
      openai("gpt-4.1-mini"),
    ];
    expect(pickLatestGptMini(models)).toBe("gpt-4.1-mini");
  });

  it("does not match an Anthropic model that happens to contain 'mini'", () => {
    // provider filter guards against a non-OpenAI id sneaking through.
    const models = [
      { id: "some-mini-claude", label: "x", provider: "anthropic" as const },
    ];
    expect(pickLatestGptMini(models)).toBeUndefined();
  });
});

describe("pickLatestGeminiFlash", () => {
  it("returns undefined when no Gemini flash model exists", () => {
    expect(
      pickLatestGeminiFlash([gemini("gemini-2.5-pro"), m("claude-sonnet-4-6")]),
    ).toBeUndefined();
  });

  it("picks the highest-version Gemini flash", () => {
    const models = [
      gemini("gemini-1.5-flash"),
      gemini("gemini-2.5-flash"),
      gemini("gemini-2.5-pro"),
    ];
    expect(pickLatestGeminiFlash(models)).toBe("gemini-2.5-flash");
  });

  it("ignores non-gemini models that contain 'flash'", () => {
    const models = [
      { id: "some-flash", label: "x", provider: "openai" as const },
      gemini("gemini-2.0-flash"),
    ];
    expect(pickLatestGeminiFlash(models)).toBe("gemini-2.0-flash");
  });
});

describe("pickPrWriterModel", () => {
  const apiKey = (id: string): ModelOption => ({
    id,
    label: id,
    provider: "anthropic",
    auth: "api_key",
  });
  const subscription = (id: string): ModelOption => ({
    id,
    label: id,
    provider: "anthropic",
    auth: "subscription",
  });

  it("returns undefined when no model is selected", () => {
    expect(pickPrWriterModel([apiKey("claude-sonnet-5")], undefined)).toBe(
      undefined,
    );
  });

  it("picks the latest Sonnet from the metered set for an API-key run", () => {
    const models = [
      apiKey("claude-sonnet-5-20260101"),
      subscription("claude-sonnet-5"),
    ];
    expect(pickPrWriterModel(models, models[0])).toBe(
      "claude-sonnet-5-20260101",
    );
  });

  it("never leaks a dated API-key Sonnet into a subscription run", () => {
    // The regression: a subscription-selected job used the OAuth token, but the
    // writer was picked across the merged list and a newer dated API-key id won,
    // which the subscription can't invoke. The writer must stay subscription-only.
    const subModel = subscription("claude-sonnet-5");
    const models = [apiKey("claude-sonnet-5-20260101"), subModel];
    expect(pickPrWriterModel(models, subModel)).toBe("claude-sonnet-5");
  });

  it("keeps the writer on the selected model's provider", () => {
    const gptMini = openai("gpt-5-mini");
    const models = [gptMini, openai("gpt-5"), subscription("claude-sonnet-5")];
    expect(pickPrWriterModel(models, openai("gpt-5"))).toBe("gpt-5-mini");
  });

  it("picks the latest Flash for a Gemini run", () => {
    const geminiPro = gemini("gemini-3-pro");
    const models = [geminiPro, gemini("gemini-3-flash")];
    expect(pickPrWriterModel(models, geminiPro)).toBe("gemini-3-flash");
  });

  it("uses auth-less Bedrock models for a Bedrock run", () => {
    const profile: ModelOption = {
      id: "us.anthropic.claude-sonnet-5-20260101-v1:0",
      label: "Claude Sonnet 5",
      provider: "bedrock",
    };
    expect(pickPrWriterModel([profile], profile)).toBe(profile.id);
  });
});

describe("fuzzyPickModel", () => {
  const models = [
    m("claude-opus-4-1"),
    m("claude-opus-4-8"),
    m("claude-sonnet-4-6"),
    openai("gpt-5"),
    openai("gpt-5-mini"),
    openai("gpt-4o-mini"),
    gemini("gemini-2.5-pro"),
    gemini("gemini-2.5-flash"),
  ];

  it("resolves a family query to the latest matching model", () => {
    expect(fuzzyPickModel("opus", models)).toBe("claude-opus-4-8");
  });

  it("matches across providers", () => {
    expect(fuzzyPickModel("sonnet", models)).toBe("claude-sonnet-4-6");
    expect(fuzzyPickModel("mini", models)).toBe("gpt-5-mini");
    expect(fuzzyPickModel("gemini", models)).toBe("gemini-2.5-pro");
    expect(fuzzyPickModel("flash", models)).toBe("gemini-2.5-flash");
  });

  it("is case-insensitive and trims the query", () => {
    expect(fuzzyPickModel("  OPUS ", models)).toBe("claude-opus-4-8");
  });

  it("matches an exact id", () => {
    expect(fuzzyPickModel("gpt-4o-mini", models)).toBe("gpt-4o-mini");
  });

  it("matches against the display label, not just the id", () => {
    const labelled = [m("model-x", "Claude Opus 4.9")];
    expect(fuzzyPickModel("opus", labelled)).toBe("model-x");
  });

  it("returns undefined for no match or an empty query", () => {
    expect(fuzzyPickModel("llama", models)).toBeUndefined();
    expect(fuzzyPickModel("   ", models)).toBeUndefined();
  });
});

describe("friendlyAwsError (bedrock)", () => {
  it("maps expired-token errors to an update-credentials message", () => {
    expect(
      friendlyAwsError({ name: "ExpiredTokenException" }, "bedrock"),
    ).toMatch(/expired/i);
    expect(friendlyAwsError({ name: "ExpiredToken" }, "bedrock")).toMatch(
      /expired/i,
    );
  });

  it("maps signature/client errors to an invalid-credentials message", () => {
    expect(
      friendlyAwsError({ name: "InvalidSignatureException" }, "bedrock"),
    ).toMatch(/invalid/i);
    expect(
      friendlyAwsError({ name: "UnrecognizedClientException" }, "bedrock"),
    ).toMatch(/invalid/i);
  });

  it("explains the missing Bedrock permission on access denied", () => {
    expect(
      friendlyAwsError({ name: "AccessDeniedException" }, "bedrock"),
    ).toMatch(/permission/i);
  });

  it("falls back to the error message for unknown errors", () => {
    expect(
      friendlyAwsError({ name: "SomethingElse", message: "boom" }, "bedrock"),
    ).toBe("boom");
  });

  it("uses a generic message when there's no name or message", () => {
    expect(friendlyAwsError({}, "bedrock")).toBe(
      "Failed to query AWS Bedrock models.",
    );
    expect(friendlyAwsError(null, "bedrock")).toBe(
      "Failed to query AWS Bedrock models.",
    );
  });
});

describe("listModelsForUser (gollm custom providers)", () => {
  // listModelsForUser only forwards `db` to the (mocked) resolution, so a stub works.
  const db = {} as unknown as typeof Database;

  function creds(overrides: Partial<ModelCredentials>): ModelCredentials {
    return {
      aws: null,
      anthropicApiKey: null,
      anthropicOauthToken: null,
      openaiApiKey: null,
      codexAuthJson: null,
      geminiApiKey: null,
      source: "user",
      ...overrides,
    };
  }

  function customProvider(
    overrides: Partial<CustomProviderCredential> & { provider: string },
  ): CustomProviderCredential {
    return {
      apiKey: null,
      apiBase: null,
      extraEnv: null,
      models: null,
      ...overrides,
    };
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveModelCredentials.mockReset();
    listCustomProviderModels.mockReset();
    // Silence the provider-failure log and let a test assert its payload.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("lists a custom provider's models tagged with its gollm provider name", async () => {
    const groq = customProvider({ provider: "groq", apiKey: "gsk-x" });
    resolveModelCredentials.mockResolvedValue(
      creds({ customProviders: [groq] }),
    );
    listCustomProviderModels.mockResolvedValue([
      { id: "llama-3.3-70b", label: "Llama 3.3 70B" },
    ]);

    const result = await listModelsForUser(db, "user-1");

    // The listing's bare {id,label} entries get re-tagged with `gollm:<id>`.
    expect(result.models).toEqual([
      { id: "llama-3.3-70b", label: "Llama 3.3 70B", provider: "gollm:groq" },
    ]);
    // The loop hands the whole stored credential to the boundary fetcher.
    expect(listCustomProviderModels).toHaveBeenCalledExactlyOnceWith(groq);
  });

  it("lists each configured custom provider under its own gollm name, in order", async () => {
    const groq = customProvider({ provider: "groq" });
    const openrouter = customProvider({ provider: "openrouter" });
    resolveModelCredentials.mockResolvedValue(
      creds({ customProviders: [groq, openrouter] }),
    );
    listCustomProviderModels.mockImplementation((cred) =>
      Promise.resolve(
        cred.provider === "groq"
          ? [{ id: "llama-3.3-70b", label: "Llama 3.3 70B" }]
          : [{ id: "anthropic/claude", label: "Claude via OpenRouter" }],
      ),
    );

    const { models } = await listModelsForUser(db, "user-1");

    // Tasks fan out (and settle) in customProviders order.
    expect(models).toEqual([
      { id: "llama-3.3-70b", label: "Llama 3.3 70B", provider: "gollm:groq" },
      {
        id: "anthropic/claude",
        label: "Claude via OpenRouter",
        provider: "gollm:openrouter",
      },
    ]);
    expect(listCustomProviderModels).toHaveBeenCalledTimes(2);
  });

  it("keeps the surviving custom providers and logs the failure when one fails", async () => {
    const groq = customProvider({ provider: "groq" });
    const vllm = customProvider({ provider: "vllm" });
    resolveModelCredentials.mockResolvedValue(
      creds({ customProviders: [groq, vllm] }),
    );
    listCustomProviderModels.mockImplementation((cred) =>
      cred.provider === "groq"
        ? Promise.resolve([{ id: "llama-3.3-70b", label: "Llama 3.3 70B" }])
        : Promise.reject(new Error("no models configured for vllm")),
    );

    const { models } = await listModelsForUser(db, "user-1");

    expect(models).toEqual([
      { id: "llama-3.3-70b", label: "Llama 3.3 70B", provider: "gollm:groq" },
    ]);
    // The failure is attributed to the provider's gollm name and logged, not thrown.
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "[bandolier:models] provider model list failed",
      { provider: "gollm:vllm", error: "no models configured for vllm" },
    );
  });

  it("does not invoke the custom-provider fetcher when the set has none", async () => {
    // The `?? []` guard: an absent customProviders list must skip the loop
    // rather than fan out a spurious boundary call. A subscription token keeps
    // the result non-empty via the static Claude list (no external calls).
    resolveModelCredentials.mockResolvedValue(
      creds({ anthropicOauthToken: "sk-ant-oat01-x" }),
    );

    const { models } = await listModelsForUser(db, "user-1");

    expect(listCustomProviderModels).not.toHaveBeenCalled();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((opt) => opt.provider === "anthropic")).toBe(true);
  });
});
