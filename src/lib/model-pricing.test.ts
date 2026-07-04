import { describe, expect, it } from "vitest";

import {
  estimateCost,
  formatCost,
  pricingForModel,
  type ModelPricing,
} from "./model-pricing";
import type { TokenUsage } from "./tokens";

describe("pricingForModel", () => {
  it("prices Claude families by substring, any version", () => {
    expect(pricingForModel("claude-opus-4-8")?.inputPer1M).toBe(5);
    expect(pricingForModel("claude-sonnet-5")?.inputPer1M).toBe(3);
    expect(pricingForModel("claude-haiku-4-5")?.inputPer1M).toBe(1);
    expect(pricingForModel("claude-fable-5")?.inputPer1M).toBe(10);
  });

  it("derives cache rates from the input rate", () => {
    const opus = pricingForModel("claude-opus-4-8")!;
    expect(opus.cacheReadPer1M).toBeCloseTo(0.5); // 0.1×
    expect(opus.cacheWritePer1M).toBeCloseTo(6.25); // 1.25×
  });

  it("resolves Bedrock inference-profile and Vertex-style ids", () => {
    expect(pricingForModel("us.anthropic.claude-sonnet-4-6")?.outputPer1M).toBe(
      15,
    );
    expect(pricingForModel("claude-opus-4-5@20251101")?.outputPer1M).toBe(25);
  });

  it("returns null for unknown or missing models", () => {
    expect(pricingForModel("gpt-5.5")).toBeNull();
    expect(pricingForModel("gemini-2.5-pro")).toBeNull();
    expect(pricingForModel(null)).toBeNull();
    expect(pricingForModel(undefined)).toBeNull();
    expect(pricingForModel("")).toBeNull();
  });
});

describe("estimateCost", () => {
  const pricing: ModelPricing = {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
  };

  it("sums each category at its own rate", () => {
    const tokens: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    expect(estimateCost(tokens, pricing)).toBeCloseTo(5 + 25 + 0.5 + 6.25);
  });

  it("is zero for empty usage", () => {
    expect(
      estimateCost(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        pricing,
      ),
    ).toBe(0);
  });
});

describe("formatCost", () => {
  it.each([
    [0, "$0.00"],
    [-1, "$0.00"],
    [0.004, "<$0.01"],
    [0.01, "$0.01"],
    [0.426, "$0.43"],
    [12.3, "$12.30"],
    [100, "$100"],
    [1234.5, "$1,235"],
  ])("formats %d as %s", (usd, want) => {
    expect(formatCost(usd)).toBe(want);
  });
});
