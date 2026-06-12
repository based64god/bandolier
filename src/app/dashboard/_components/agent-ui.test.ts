import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expiresIn, STATUS_STYLES } from "~/app/dashboard/_components/agent-ui";

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
