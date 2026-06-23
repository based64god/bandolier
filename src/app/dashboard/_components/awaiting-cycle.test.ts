import { describe, expect, it } from "vitest";

import { nextAwaitingTarget } from "~/app/dashboard/_components/agent-ui";

describe("nextAwaitingTarget", () => {
  it("returns null when nothing is awaiting input", () => {
    expect(nextAwaitingTarget([], null)).toBeNull();
    expect(nextAwaitingTarget([], "anything")).toBeNull();
  });

  it("starts at the first session when there is no current target", () => {
    expect(nextAwaitingTarget(["a", "b", "c"], null)).toBe("a");
  });

  it("advances to the session after the current one", () => {
    expect(nextAwaitingTarget(["a", "b", "c"], "a")).toBe("b");
    expect(nextAwaitingTarget(["a", "b", "c"], "b")).toBe("c");
  });

  it("wraps from the last session back to the first", () => {
    expect(nextAwaitingTarget(["a", "b", "c"], "c")).toBe("a");
  });

  it("restarts from the top when the current target is no longer awaiting", () => {
    // "x" resolved and dropped out of the list — cycling resumes at the top.
    expect(nextAwaitingTarget(["a", "b"], "x")).toBe("a");
  });

  it("stays put with a single awaiting session", () => {
    expect(nextAwaitingTarget(["only"], null)).toBe("only");
    expect(nextAwaitingTarget(["only"], "only")).toBe("only");
  });
});
