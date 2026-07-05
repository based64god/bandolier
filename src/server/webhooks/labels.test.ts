import { describe, expect, it } from "vitest";

import {
  CPU_LABEL_PREFIX,
  EFFORT_LABEL_PREFIX,
  labelQuery,
  MODEL_LABEL_PREFIX,
  wantsIssueOutput,
} from "~/server/webhooks/labels";

const labels = (...names: string[]) => names.map((name) => ({ name }));

describe("labelQuery", () => {
  it("returns the value of the first label with the prefix", () => {
    expect(labelQuery(labels("model:opus"), MODEL_LABEL_PREFIX)).toBe("opus");
  });

  it("matches the prefix case-insensitively but preserves the value's case", () => {
    expect(labelQuery(labels("Model:GPT-5"), MODEL_LABEL_PREFIX)).toBe("GPT-5");
  });

  it("trims surrounding whitespace on the label and the value", () => {
    expect(labelQuery(labels("  cpu: 4 "), CPU_LABEL_PREFIX)).toBe("4");
  });

  it("returns the first matching label when several carry the prefix", () => {
    expect(
      labelQuery(labels("effort:low", "effort:high"), EFFORT_LABEL_PREFIX),
    ).toBe("low");
  });

  it("ignores a prefix with an empty value", () => {
    expect(labelQuery(labels("model:", "model:sonnet"), MODEL_LABEL_PREFIX)).toBe(
      "sonnet",
    );
  });

  it("returns null when no label carries the prefix", () => {
    expect(labelQuery(labels("bug", "model:opus"), CPU_LABEL_PREFIX)).toBeNull();
  });

  it("returns null for an empty label set", () => {
    expect(labelQuery([], MODEL_LABEL_PREFIX)).toBeNull();
  });
});

describe("wantsIssueOutput", () => {
  it("is true when an output:issue label is present", () => {
    expect(wantsIssueOutput(labels("bug", "output:issue"))).toBe(true);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(wantsIssueOutput(labels(" Output:Issue "))).toBe(true);
  });

  it("is false without the label", () => {
    expect(wantsIssueOutput(labels("output:pr", "enhancement"))).toBe(false);
  });

  it("is false for an empty label set", () => {
    expect(wantsIssueOutput([])).toBe(false);
  });
});
