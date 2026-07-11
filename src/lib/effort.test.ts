import { describe, expect, it } from "vitest";

import {
  EFFORT_LEVELS,
  isEffortLevel,
  parseEffortQuery,
  providerSupportsEffort,
} from "~/lib/effort";

describe("isEffortLevel", () => {
  it("accepts each known level", () => {
    for (const level of EFFORT_LEVELS) {
      expect(isEffortLevel(level)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isEffortLevel("highest")).toBe(false);
    expect(isEffortLevel("")).toBe(false);
    expect(isEffortLevel("HIGH")).toBe(false); // case-sensitive narrow
  });
});

describe("providerSupportsEffort", () => {
  it("is true for every provider — all runs go through the claude CLI", () => {
    expect(providerSupportsEffort("anthropic")).toBe(true);
    expect(providerSupportsEffort("bedrock")).toBe(true);
    expect(providerSupportsEffort("openai")).toBe(true);
    expect(providerSupportsEffort("gemini")).toBe(true);
  });
});

describe("parseEffortQuery", () => {
  it("resolves a known level case-insensitively and trimmed", () => {
    expect(parseEffortQuery("high")).toBe("high");
    expect(parseEffortQuery("  XHIGH ")).toBe("xhigh");
    expect(parseEffortQuery("Max")).toBe("max");
  });

  it("returns undefined for an unknown or empty query", () => {
    expect(parseEffortQuery("turbo")).toBeUndefined();
    expect(parseEffortQuery("")).toBeUndefined();
    expect(parseEffortQuery("   ")).toBeUndefined();
  });
});
