import { describe, expect, it } from "vitest";

import { cleanSessionToken } from "~/server/agents/aws";

describe("cleanSessionToken", () => {
  it("returns a non-empty token trimmed of surrounding whitespace", () => {
    expect(cleanSessionToken("  tok123  ")).toBe("tok123");
  });

  it("returns a normal token unchanged", () => {
    expect(cleanSessionToken("tok123")).toBe("tok123");
  });

  it("returns undefined for null", () => {
    expect(cleanSessionToken(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(cleanSessionToken(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace-only string", () => {
    expect(cleanSessionToken("")).toBeUndefined();
    expect(cleanSessionToken("   ")).toBeUndefined();
  });
});
