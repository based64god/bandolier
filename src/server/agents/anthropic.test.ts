import { describe, expect, it } from "vitest";

import { validateAnthropicOauthToken } from "~/server/agents/anthropic";

describe("validateAnthropicOauthToken", () => {
  it("accepts a setup-token-shaped OAuth token", () => {
    expect(
      validateAnthropicOauthToken(`sk-ant-oat01-${"a".repeat(40)}`),
    ).toEqual({ valid: true });
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
