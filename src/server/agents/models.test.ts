import { describe, expect, it } from "vitest";

import {
  friendlyAwsError,
  fuzzyPickModel,
  pickDefaultModel,
  pickLatestGeminiFlash,
  pickLatestGptMini,
  pickLatestSonnet,
  pickPrWriterModel,
  type ModelOption,
} from "~/server/agents/models";

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

describe("friendlyAwsError", () => {
  it("maps expired-token errors to an update-credentials message", () => {
    expect(friendlyAwsError({ name: "ExpiredTokenException" })).toMatch(
      /expired/i,
    );
    expect(friendlyAwsError({ name: "ExpiredToken" })).toMatch(/expired/i);
  });

  it("maps signature/client errors to an invalid-credentials message", () => {
    expect(friendlyAwsError({ name: "InvalidSignatureException" })).toMatch(
      /invalid/i,
    );
    expect(friendlyAwsError({ name: "UnrecognizedClientException" })).toMatch(
      /invalid/i,
    );
  });

  it("explains the missing Bedrock permission on access denied", () => {
    expect(friendlyAwsError({ name: "AccessDeniedException" })).toMatch(
      /permission/i,
    );
  });

  it("falls back to the error message for unknown errors", () => {
    expect(friendlyAwsError({ name: "SomethingElse", message: "boom" })).toBe(
      "boom",
    );
  });

  it("uses a generic message when there's no name or message", () => {
    expect(friendlyAwsError({})).toBe("Failed to query AWS Bedrock models.");
    expect(friendlyAwsError(null)).toBe("Failed to query AWS Bedrock models.");
  });
});
