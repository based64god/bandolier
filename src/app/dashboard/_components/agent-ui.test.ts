import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expiresAtLocal,
  isAgentDone,
  isAgentOutputResolved,
  SPINNER_STATUSES,
  STATUS_ICON_PATHS,
  STATUS_STYLES,
  taskNameTooltip,
} from "~/app/dashboard/_components/agent-ui";

const KNOWN_STATUSES = ["Running", "Pending", "Failed", "Succeeded", "Unknown"];

describe("expiresAtLocal", () => {
  beforeEach(() => {
    // Pin "now" to a fixed instant so "today vs. another day" is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const inSeconds = (s: number) =>
    new Date(Date.now() + s * 1000).toISOString();

  it("returns an em dash for a null expiry", () => {
    expect(expiresAtLocal(null)).toBe("—");
  });

  it("returns 'expiring…' when already past", () => {
    expect(expiresAtLocal(inSeconds(-10))).toBe("expiring…");
    expect(expiresAtLocal(inSeconds(0))).toBe("expiring…");
  });

  it("shows the local clock time for an expiry later today", () => {
    const iso = inSeconds(2 * 3600);
    const expected = new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(expiresAtLocal(iso)).toBe(expected);
  });

  it("prefixes the date when the expiry falls on another day", () => {
    const iso = inSeconds(3 * 86_400);
    const when = new Date(iso);
    const date = when.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const time = when.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(expiresAtLocal(iso)).toBe(`${date}, ${time}`);
  });
});

describe("STATUS_STYLES", () => {
  it("defines a style for each known pod status", () => {
    for (const status of KNOWN_STATUSES) {
      expect(STATUS_STYLES[status]).toBeTruthy();
    }
  });
});

describe("STATUS_ICON_PATHS", () => {
  it("defines a glyph for each known pod status, so the pill can collapse to an icon", () => {
    for (const status of KNOWN_STATUSES) {
      expect(STATUS_ICON_PATHS[status]).toBeTruthy();
    }
  });

  it("provides an Unknown fallback for unrecognised statuses", () => {
    // The badge falls back to the Unknown glyph for statuses it doesn't know.
    expect(STATUS_ICON_PATHS.Unknown).toBeTruthy();
    expect(STATUS_ICON_PATHS.Sideways).toBe(undefined);
  });
});

describe("SPINNER_STATUSES", () => {
  it("spins the in-flight Running status", () => {
    expect(SPINNER_STATUSES.has("Running")).toBe(true);
  });

  it("leaves terminal and unknown statuses as static glyphs", () => {
    for (const status of ["Pending", "Failed", "Succeeded", "Unknown"]) {
      expect(SPINNER_STATUSES.has(status)).toBe(false);
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

describe("taskNameTooltip", () => {
  it("surfaces the full prompt for an ad-hoc task whose label is a truncated preview", () => {
    const prompt = "a".repeat(80);
    expect(
      taskNameTooltip({
        displayName: `${prompt.slice(0, 60)}…`,
        prompt,
        issueNumber: null,
      }),
    ).toBe(prompt);
  });

  it("keeps the label for an issue task, whose prompt is the whole issue body", () => {
    expect(
      taskNameTooltip({
        displayName: "#42: Fix the thing",
        prompt: "## Issue #42: Fix the thing\n\nLong body…",
        issueNumber: "42",
      }),
    ).toBe("#42: Fix the thing");
  });

  it("falls back to the label when no prompt is available", () => {
    expect(
      taskNameTooltip({
        displayName: "some-pod-name",
        prompt: null,
        issueNumber: null,
      }),
    ).toBe("some-pod-name");
  });
});

describe("isAgentOutputResolved", () => {
  const base = {
    pullRequestUrl: null,
    pullRequestState: null,
    createdIssueUrl: null,
    createdIssueState: null,
  };

  it("is not resolved when the task has produced no output yet", () => {
    expect(isAgentOutputResolved(base)).toBe(false);
  });

  it("is not resolved while the pull request is still open", () => {
    expect(
      isAgentOutputResolved({
        ...base,
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "open",
      }),
    ).toBe(false);
  });

  it("resolves a merged or closed pull request", () => {
    for (const state of ["merged", "closed"] as const) {
      expect(
        isAgentOutputResolved({
          ...base,
          pullRequestUrl: "https://github.com/o/r/pull/1",
          pullRequestState: state,
        }),
      ).toBe(true);
    }
  });

  it("treats a PR with unknown (null) state as unresolved", () => {
    expect(
      isAgentOutputResolved({
        ...base,
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: null,
      }),
    ).toBe(false);
  });

  it("resolves a closed or completed created issue", () => {
    for (const state of ["closed", "completed"] as const) {
      expect(
        isAgentOutputResolved({
          ...base,
          createdIssueUrl: "https://github.com/o/r/issues/1",
          createdIssueState: state,
        }),
      ).toBe(true);
    }
  });

  it("is not resolved while the created issue is still open", () => {
    expect(
      isAgentOutputResolved({
        ...base,
        createdIssueUrl: "https://github.com/o/r/issues/1",
        createdIssueState: "open",
      }),
    ).toBe(false);
  });

  it("prefers the created issue over the PR, mirroring the output badge", () => {
    // Issue present but open → unresolved, even if the PR is merged.
    expect(
      isAgentOutputResolved({
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "merged",
        createdIssueUrl: "https://github.com/o/r/issues/1",
        createdIssueState: "open",
      }),
    ).toBe(false);
  });
});
