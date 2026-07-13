import { describe, expect, it } from "vitest";

import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";

describe("SPAWNED_BY_LABEL", () => {
  it("is the namespaced bandolier label key", () => {
    expect(SPAWNED_BY_LABEL).toBe("bandolier.io/spawned-by");
  });
});

describe("spawnedByLabelValue", () => {
  it("passes through an already-label-safe id unchanged", () => {
    expect(spawnedByLabelValue("user_123")).toBe("user_123");
    expect(spawnedByLabelValue("abc-DEF.0")).toBe("abc-DEF.0");
  });

  it("hashes an id containing label-unsafe characters", () => {
    const value = spawnedByLabelValue("user@example.com");
    expect(value).toMatch(/^[0-9a-f]{63}$/);
    expect(value).not.toContain("@");
  });

  it("hashes an id that starts with a non-alphanumeric character", () => {
    const value = spawnedByLabelValue("-leading");
    expect(value).toMatch(/^[0-9a-f]{63}$/);
  });

  it("hashes an id longer than 63 characters", () => {
    const value = spawnedByLabelValue("a".repeat(100));
    expect(value).toMatch(/^[0-9a-f]{63}$/);
  });

  it("is stable across calls for the same id", () => {
    expect(spawnedByLabelValue("user@example.com")).toBe(
      spawnedByLabelValue("user@example.com"),
    );
  });

  it("produces a value within Kubernetes' 63-char label limit", () => {
    expect(spawnedByLabelValue("a".repeat(200)).length).toBeLessThanOrEqual(63);
  });
});
