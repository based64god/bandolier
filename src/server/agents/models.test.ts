import { describe, expect, it } from "vitest";

import {
  pickDefaultModel,
  pickLatestSonnet,
  type ModelOption,
} from "~/server/agents/models";

const m = (id: string, label = id): ModelOption => ({ id, label });

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
