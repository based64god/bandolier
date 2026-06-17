import { describe, expect, it } from "vitest";

import {
  fuzzyPickModel,
  pickDefaultModel,
  pickLatestGeminiFlash,
  pickLatestGptMini,
  pickLatestSonnet,
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
