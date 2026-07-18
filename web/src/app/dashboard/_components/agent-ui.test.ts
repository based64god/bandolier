import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expiresAtLocal,
  explainFailure,
  isAgentDone,
  isAgentOutputOpen,
  isAgentOutputResolved,
  isAgentResolved,
  SPINNER_STATUSES,
  STATUS_ICON_PATHS,
  STATUS_STYLES,
  resetsInLabel,
  taskNameLabel,
  taskNameTooltip,
  usageMeter,
  usedAgoLabel,
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

describe("usedAgoLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const agoSeconds = (s: number) => new Date(Date.now() - s * 1000);

  it("reads 'just now' under a minute (and for future timestamps)", () => {
    expect(usedAgoLabel(agoSeconds(0))).toBe("just now");
    expect(usedAgoLabel(agoSeconds(59))).toBe("just now");
    expect(usedAgoLabel(agoSeconds(-30))).toBe("just now");
  });

  it("counts whole minutes under an hour", () => {
    expect(usedAgoLabel(agoSeconds(60))).toBe("1m ago");
    expect(usedAgoLabel(agoSeconds(59 * 60))).toBe("59m ago");
  });

  it("counts whole hours under a day", () => {
    expect(usedAgoLabel(agoSeconds(3600))).toBe("1h ago");
    expect(usedAgoLabel(agoSeconds(23 * 3600))).toBe("23h ago");
  });

  it("counts whole days beyond that", () => {
    expect(usedAgoLabel(agoSeconds(86_400))).toBe("1d ago");
    expect(usedAgoLabel(agoSeconds(3 * 86_400))).toBe("3d ago");
  });

  it("accepts an ISO string too", () => {
    expect(usedAgoLabel(agoSeconds(2 * 3600).toISOString())).toBe("2h ago");
  });
});

describe("usageMeter", () => {
  it("returns the run/budget percentage, clamped and rounded", () => {
    expect(usageMeter(0, 25).pct).toBe(0);
    expect(usageMeter(5, 25).pct).toBe(20);
    // Rounds to the nearest whole percent.
    expect(usageMeter(1, 3).pct).toBe(33);
    // An over-budget window can't exceed a full bar.
    expect(usageMeter(40, 25).pct).toBe(100);
  });

  it("is empty (not NaN) when the budget is zero", () => {
    expect(usageMeter(3, 0).pct).toBe(0);
  });

  it("escalates tone as the window fills", () => {
    expect(usageMeter(5, 25).tone).toBe("ok"); // 20%
    expect(usageMeter(18, 25).tone).toBe("warn"); // 72%
    expect(usageMeter(24, 25).tone).toBe("max"); // 96%
  });
});

describe("resetsInLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

  it("reads 'resetting…' once the window is due", () => {
    expect(resetsInLabel(inSeconds(0))).toBe("resetting…");
    expect(resetsInLabel(inSeconds(-120))).toBe("resetting…");
  });

  it("counts minutes under an hour", () => {
    expect(resetsInLabel(inSeconds(40 * 60))).toBe("resets in 40m");
  });

  it("counts hours beyond that", () => {
    expect(resetsInLabel(inSeconds(2 * 3600))).toBe("resets in 2h");
  });

  it("accepts an ISO string too", () => {
    expect(resetsInLabel(inSeconds(3 * 3600).toISOString())).toBe(
      "resets in 3h",
    );
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

describe("taskNameLabel", () => {
  it("expands a server-truncated preview to the full prompt, so the cell fills its column", () => {
    const prompt = "a".repeat(80);
    expect(
      taskNameLabel({
        displayName: `${prompt.slice(0, 60)}…`,
        prompt,
        issueNumber: null,
      }),
    ).toBe(prompt);
  });

  it("keeps a short ad-hoc label that was never truncated", () => {
    expect(
      taskNameLabel({
        displayName: "fix the login bug",
        prompt: "fix the login bug",
        issueNumber: null,
      }),
    ).toBe("fix the login bug");
  });

  it("keeps a label renamed via the API, which no longer prefixes the prompt", () => {
    expect(
      taskNameLabel({
        displayName: "hotfix — do not touch…",
        prompt: "a".repeat(80),
        issueNumber: null,
      }),
    ).toBe("hotfix — do not touch…");
  });

  it("keeps the issue label for an issue task", () => {
    expect(
      taskNameLabel({
        displayName: "#42: Fix the thing",
        prompt: "## Issue #42: Fix the thing\n\nLong body…",
        issueNumber: "42",
      }),
    ).toBe("#42: Fix the thing");
  });

  it("falls back to the label when no prompt is available", () => {
    expect(
      taskNameLabel({
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

describe("isAgentResolved", () => {
  const base = {
    status: "Succeeded",
    expired: false,
    pullRequestUrl: null,
    pullRequestState: null,
    createdIssueUrl: null,
    createdIssueState: null,
  };

  it("resolves a succeeded task that has expired, even without GitHub output", () => {
    expect(isAgentResolved({ ...base, expired: true })).toBe(true);
  });

  it("does not resolve a succeeded task that is still live", () => {
    expect(isAgentResolved({ ...base, expired: false })).toBe(false);
  });

  it("resolves a failed task that has expired, even without GitHub output", () => {
    expect(isAgentResolved({ ...base, status: "Failed", expired: true })).toBe(
      true,
    );
  });

  it("does not resolve a non-terminal task just because it expired", () => {
    expect(isAgentResolved({ ...base, status: "Running", expired: true })).toBe(
      false,
    );
  });

  it("still resolves via terminal GitHub output when not succeeded-and-expired", () => {
    expect(
      isAgentResolved({
        ...base,
        status: "Running",
        expired: false,
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "merged",
      }),
    ).toBe(true);
  });

  it("does not resolve an expired task whose pull request is still open", () => {
    expect(
      isAgentResolved({
        ...base,
        expired: true,
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "open",
      }),
    ).toBe(false);
  });

  it("does not resolve an expired task whose created issue is still open", () => {
    expect(
      isAgentResolved({
        ...base,
        expired: true,
        createdIssueUrl: "https://github.com/o/r/issues/1",
        createdIssueState: "open",
      }),
    ).toBe(false);
  });

  it("resolves an expired task whose pull request has closed", () => {
    expect(
      isAgentResolved({
        ...base,
        expired: true,
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "closed",
      }),
    ).toBe(true);
  });
});

describe("isAgentOutputOpen", () => {
  const base = {
    pullRequestUrl: null,
    pullRequestState: null,
    createdIssueUrl: null,
    createdIssueState: null,
  };

  it("is false when there is no GitHub output", () => {
    expect(isAgentOutputOpen(base)).toBe(false);
  });

  it("is true for an open pull request", () => {
    expect(
      isAgentOutputOpen({
        ...base,
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "open",
      }),
    ).toBe(true);
  });

  it("is true for an open created issue", () => {
    expect(
      isAgentOutputOpen({
        ...base,
        createdIssueUrl: "https://github.com/o/r/issues/1",
        createdIssueState: "open",
      }),
    ).toBe(true);
  });

  it("prefers the created issue over the pull request", () => {
    expect(
      isAgentOutputOpen({
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "open",
        createdIssueUrl: "https://github.com/o/r/issues/1",
        createdIssueState: "closed",
      }),
    ).toBe(false);
  });

  it("is false for a merged pull request", () => {
    expect(
      isAgentOutputOpen({
        ...base,
        pullRequestUrl: "https://github.com/o/r/pull/1",
        pullRequestState: "merged",
      }),
    ).toBe(false);
  });
});

describe("explainFailure", () => {
  it("explains an OOM kill and suggests raising the memory limit", () => {
    const e = explainFailure({
      reason: "OOMKilled",
      exitCode: 137,
      message: null,
    });
    expect(e.title).toBe("Out of memory");
    expect(e.why).toContain("memory");
    expect(e.fix).toContain("memory limit");
  });

  it("treats a bare SIGKILL (exit 137) as a likely OOM kill", () => {
    const e = explainFailure({ reason: "Error", exitCode: 137, message: null });
    expect(e.why).toContain("137");
    expect(e.fix).toContain("memory limit");
  });

  it("surfaces the Kubernetes eviction message verbatim", () => {
    const e = explainFailure({
      reason: "Evicted",
      exitCode: null,
      message: "The node was low on resource: memory.",
    });
    expect(e.title).toBe("Evicted");
    expect(e.why).toBe("The node was low on resource: memory.");
  });

  it("explains an eviction without a message", () => {
    const e = explainFailure({
      reason: "Evicted",
      exitCode: null,
      message: null,
    });
    expect(e.why).toContain("evicted");
  });

  it("explains a deadline overrun", () => {
    const e = explainFailure({
      reason: "DeadlineExceeded",
      exitCode: null,
      message: null,
    });
    expect(e.title).toBe("Deadline exceeded");
  });

  it("points a plain crash at the logs, keeping the exit code", () => {
    const e = explainFailure({ reason: "Error", exitCode: 1, message: null });
    expect(e.title).toBe("Exited with code 1");
    expect(e.fix).toContain("logs");
  });

  it("prefers the container's own message for a crash", () => {
    const e = explainFailure({
      reason: "Error",
      exitCode: 2,
      message: "panic: boom",
    });
    expect(e.why).toBe("panic: boom");
  });

  it("falls back to the raw reason when nothing else is known", () => {
    const e = explainFailure({
      reason: "NodeLost",
      exitCode: null,
      message: null,
    });
    expect(e.title).toBe("NodeLost");
    expect(e.fix).toContain("logs");
  });
});
