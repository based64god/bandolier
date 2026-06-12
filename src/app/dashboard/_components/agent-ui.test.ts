import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expiresIn,
  isAgentDone,
  STATUS_STYLES,
} from "~/app/dashboard/_components/agent-ui";

describe("expiresIn", () => {
  beforeEach(() => {
    // Pin "now" to a fixed instant so relative formatting is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const inSeconds = (s: number) =>
    new Date(Date.now() + s * 1000).toISOString();

  it("returns an em dash for a null expiry", () => {
    expect(expiresIn(null)).toBe("—");
  });

  it("returns 'expiring…' when already past", () => {
    expect(expiresIn(inSeconds(-10))).toBe("expiring…");
    expect(expiresIn(inSeconds(0))).toBe("expiring…");
  });

  it("formats sub-minute durations in seconds", () => {
    expect(expiresIn(inSeconds(45))).toBe("45s");
  });

  it("formats sub-hour durations in whole minutes", () => {
    expect(expiresIn(inSeconds(125))).toBe("2m");
  });

  it("formats multi-hour durations as hours and minutes", () => {
    expect(expiresIn(inSeconds(3 * 3600 + 25 * 60))).toBe("3h 25m");
  });
});

describe("STATUS_STYLES", () => {
  it("defines a style for each known pod status", () => {
    for (const status of [
      "Running",
      "Pending",
      "Failed",
      "Succeeded",
      "Unknown",
    ]) {
      expect(STATUS_STYLES[status]).toBeTruthy();
    }
  });
});

describe("isAgentDone", () => {
  it("treats terminal phases as done", () => {
    expect(isAgentDone("Succeeded")).toBe(true);
    expect(isAgentDone("Failed")).toBe(true);
  });

  it("treats in-flight and unknown phases as not done", () => {
    expect(isAgentDone("Running")).toBe(false);
    expect(isAgentDone("Pending")).toBe(false);
    expect(isAgentDone("Unknown")).toBe(false);
  });

  it("sinks completed agents to the bottom when used as a sort key", () => {
    const agents = [
      { name: "a", status: "Succeeded" },
      { name: "b", status: "Running" },
      { name: "c", status: "Failed" },
      { name: "d", status: "Pending" },
    ];
    const sorted = [...agents].sort(
      (x, y) => Number(isAgentDone(x.status)) - Number(isAgentDone(y.status)),
    );
    // Stable sort keeps active agents in their original order, ahead of done ones.
    expect(sorted.map((a) => a.name)).toEqual(["b", "d", "a", "c"]);
  });
});
