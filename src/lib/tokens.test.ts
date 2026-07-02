import { describe, expect, it } from "vitest";

import {
  formatTokens,
  parseTokenMarkerPayload,
  parseTokenUsageFromLogs,
  totalTokens,
  type TokenUsage,
} from "./tokens";

describe("parseTokenMarkerPayload", () => {
  it("parses a full usage object", () => {
    expect(
      parseTokenMarkerPayload(
        '{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}',
      ),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    });
  });

  it("defaults missing fields to zero", () => {
    expect(parseTokenMarkerPayload('{"input_tokens":7}')).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("coerces negative / non-numeric fields to zero", () => {
    expect(
      parseTokenMarkerPayload('{"input_tokens":-3,"output_tokens":"x"}'),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("returns null for non-JSON or non-object input", () => {
    expect(parseTokenMarkerPayload("not json")).toBeNull();
    expect(parseTokenMarkerPayload("42")).toBeNull();
    expect(parseTokenMarkerPayload("null")).toBeNull();
  });
});

describe("parseTokenUsageFromLogs", () => {
  it("returns null when no marker is present", () => {
    expect(parseTokenUsageFromLogs("just some logs\n")).toBeNull();
  });

  it("picks the last marker (the cumulative total)", () => {
    const logs =
      '12:00 [harness] BANDOLIER_TOKENS={"input_tokens":1,"output_tokens":1}\n' +
      "12:01 [harness] doing work\n" +
      '12:02 [harness] BANDOLIER_TOKENS={"input_tokens":9,"output_tokens":3}\n';
    expect(parseTokenUsageFromLogs(logs)).toEqual({
      inputTokens: 9,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("handles a marker at end of buffer with no trailing newline", () => {
    expect(
      parseTokenUsageFromLogs('BANDOLIER_TOKENS={"output_tokens":4}'),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});

describe("totalTokens", () => {
  it("sums every category", () => {
    const u: TokenUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    };
    expect(totalTokens(u)).toBe(10);
  });
});

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [1234, "1.2K"],
    [12_345, "12.3K"],
    [150_000, "150K"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
  ])("formats %i as %s", (n, want) => {
    expect(formatTokens(n)).toBe(want);
  });
});
