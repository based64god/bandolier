import { type V1Pod } from "@kubernetes/client-node";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type PodInspection } from "~/server/agents/pod-inspection";

// Unit tests for the persisted-run half of the task view: the visibility
// scoping of loadExpiredRuns (repo-wide vs. owner-only, mirroring the pod
// label selectors) and the row→task mapping of expiredRunToTask. The I/O
// collaborators (GitHub poll token + item states, the k8s-backed pod
// inspection pulled in transitively) are stubbed so the mapping can be
// exercised without a database, Kubernetes, or GitHub. Factories defer to
// top-level vi.fn()s through arrows to dodge hoisting TDZ.

const resolvePollToken = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/github-app", () => ({
  resolvePollToken: (...a: unknown[]) => resolvePollToken(...(a as [])),
}));

const resolveItemStates = vi.fn<() => Promise<unknown>>();
vi.mock("~/server/agents/github-issues", () => ({
  resolveItemStates: (...a: unknown[]) => resolveItemStates(...(a as [])),
}));

// inspectPod reads a pod's logs via the k8s client; stubbed so podToTask's
// mapping runs without Kubernetes. Deferred to a controllable top-level vi.fn so
// each test shapes the inspection (URLs, awaiting state, tokens); the default is
// a full running inspection. create-job is pulled in transitively for
// JOB_TTL_SECONDS (env), pinned to 600 so expiry math is deterministic.
const inspectPod = vi.fn<() => Promise<PodInspection>>();
vi.mock("~/server/agents/pod-inspection", () => ({
  inspectPod: (...a: unknown[]) => inspectPod(...(a as [])),
}));
vi.mock("~/server/agents/create-job", () => ({ JOB_TTL_SECONDS: 600 }));

const {
  expiredRunToTask,
  loadExpiredRuns,
  loadPersistedOutputs,
  mergeOutput,
  podJobName,
  podToTask,
} = await import("~/server/agents/task-view");

// A run row as recordRun + the ingest callback leave it.
function runRow(overrides: Record<string, unknown> = {}) {
  return {
    jobName: "bandolier-agent-1",
    namespace: "acme-app",
    displayName: "Fix the flaky test",
    createdBy: "ada",
    spawnedBy: "u1",
    repoFullName: "acme/app",
    issueNumber: null,
    parentJobName: null,
    ciResumeSha: null,
    transcriptKey: "runs/bandolier-agent-1/transcript.log",
    status: "Succeeded",
    pullRequestUrl: "https://github.com/acme/app/pull/7",
    createdIssueUrl: null,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    agentImage: null,
    harnessContract: 1,
    createdAt: new Date("2026-07-01T12:00:00Z"),
    updatedAt: new Date("2026-07-01T12:30:00Z"),
    ...overrides,
  } as never;
}

// A full inspection as inspectPod resolves it (the log-read succeeded). Tests
// override individual fields to exercise the live-log vs. persisted fallback.
function fullInspection(overrides: Partial<PodInspection> = {}): PodInspection {
  return {
    currently: "Writing the fix",
    awaitingInput: false,
    pullRequestUrl: null,
    createdIssueUrl: null,
    tokens: null,
    ...overrides,
  };
}

// A V1Pod as the k8s list returns it. Only the fields podToTask/podJobName read
// are populated; the whole literal is asserted as V1Pod (the client's many
// required container-status fields are irrelevant to the mapping under test).
function podFixture(
  o: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    phase?: string;
    finishedAt?: Date;
    terminated?: { reason?: string; exitCode?: number; message?: string };
    reason?: string;
    env?: { name: string; value: string }[];
    creationTimestamp?: Date;
  } = {},
): V1Pod {
  const terminated =
    o.finishedAt || o.terminated
      ? { finishedAt: o.finishedAt, ...o.terminated }
      : undefined;
  return {
    metadata: {
      name: o.name ?? "bandolier-agent-1-abc",
      labels: o.labels ?? {},
      annotations: o.annotations ?? {},
      creationTimestamp: o.creationTimestamp,
    },
    spec: { containers: [{ name: "agent", env: o.env ?? [] }] },
    status: {
      phase: o.phase ?? "Running",
      reason: o.reason,
      containerStatuses: terminated
        ? [{ name: "agent", state: { terminated } }]
        : undefined,
    },
  } as V1Pod;
}

beforeEach(() => {
  resolvePollToken.mockReset().mockResolvedValue(null);
  resolveItemStates.mockReset().mockResolvedValue({
    pullRequestState: "open",
    createdIssueState: null,
    issueState: null,
  });
  inspectPod.mockReset().mockResolvedValue(fullInspection());
});

describe("expiredRunToTask", () => {
  it("maps a persisted row into the task shape, marked expired", async () => {
    const task = await expiredRunToTask(
      runRow(),
      {} as never,
      null,
      Date.now(),
      "u1",
    );

    expect(task).toMatchObject({
      // The job name stands in for the (deleted) pod name, so log reads fall
      // through to the persisted transcript.
      name: "bandolier-agent-1",
      jobName: "bandolier-agent-1",
      displayName: "Fix the flaky test",
      repoFullName: "acme/app",
      status: "Succeeded",
      ownedByViewer: true,
      expired: true,
      interactive: false,
      awaitingInput: false,
      expiresAt: null,
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      pullRequestState: "open",
      outputType: "pr",
      source: "dashboard",
      tokens: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    expect(task.createdAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("shows Unknown for a run whose harness predates status reporting", async () => {
    const task = await expiredRunToTask(
      runRow({ status: null }),
      {} as never,
      null,
      Date.now(),
      "u1",
    );
    expect(task.status).toBe("Unknown");
  });

  it("marks another user's run as not owned by the viewer", async () => {
    const task = await expiredRunToTask(
      runRow({ spawnedBy: "u2" }),
      {} as never,
      null,
      Date.now(),
      "u1",
    );
    expect(task.ownedByViewer).toBe(false);
  });

  it("reconstructs the issue link and source for a webhook run", async () => {
    const task = await expiredRunToTask(
      runRow({ issueNumber: "42" }),
      {} as never,
      null,
      Date.now(),
      "u1",
    );
    expect(task.source).toBe("github-issue");
    expect(task.issueUrl).toBe("https://github.com/acme/app/issues/42");
  });

  it("reports issue output when the run created an issue", async () => {
    const task = await expiredRunToTask(
      runRow({
        pullRequestUrl: null,
        createdIssueUrl: "https://github.com/acme/app/issues/50",
      }),
      {} as never,
      null,
      Date.now(),
      "u1",
    );
    expect(task.outputType).toBe("issue");
  });

  it("leaves tokens null for a run that never reported usage", async () => {
    const task = await expiredRunToTask(
      runRow({
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
      }),
      {} as never,
      null,
      Date.now(),
      "u1",
    );
    expect(task.tokens).toBeNull();
  });
});

describe("loadExpiredRuns visibility scoping", () => {
  // Captures the drizzle condition passed to .where() and renders it to SQL so
  // the scoping — the security boundary here — is asserted on what would
  // actually reach the database.
  function fakeDb(captured: { sql: string; params: unknown[] }[]) {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: (cond: never) => {
        captured.push(new PgDialect().sqlToQuery(cond));
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve([]),
    };
    return chain as never;
  }

  it("scopes a repo query in the repo's own namespace to the repo (collaborator-visible)", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    await loadExpiredRuns(fakeDb(captured), {
      viewerId: "u1",
      namespace: "acme-app",
      repoFullName: "acme/app",
      liveJobNames: [],
    });

    const where = captured[0]!;
    expect(where.sql).toContain('"repo_full_name"');
    expect(where.sql).not.toContain('"spawned_by"');
    expect(where.params).toContain("acme/app");
  });

  it("falls back to owner scoping when the namespace is not the repo's", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    await loadExpiredRuns(fakeDb(captured), {
      viewerId: "u1",
      namespace: "someone-elses-ns",
      repoFullName: "acme/app",
      liveJobNames: [],
    });

    const where = captured[0]!;
    expect(where.sql).toContain('"spawned_by"');
    expect(where.params).toContain("u1");
  });

  it("stays owner-scoped for a repo-less (overview) query", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    await loadExpiredRuns(fakeDb(captured), {
      viewerId: "u1",
      liveJobNames: [],
    });

    const where = captured[0]!;
    expect(where.sql).toContain('"spawned_by"');
    expect(where.params).toContain("u1");
  });

  it("excludes runs that still have a live pod, and requires a reported callback", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    await loadExpiredRuns(fakeDb(captured), {
      viewerId: "u1",
      namespace: "acme-app",
      repoFullName: "acme/app",
      liveJobNames: ["job-live-1", "job-live-2"],
    });

    const where = captured[0]!;
    expect(where.sql).toContain('"job_name" not in');
    expect(where.params).toEqual(
      expect.arrayContaining(["job-live-1", "job-live-2"]),
    );
    expect(where.sql).toContain('"harness_contract" is not null');
  });
});

describe("podJobName", () => {
  it("reads the bandolier.io/job label", () => {
    expect(
      podJobName(podFixture({ labels: { "bandolier.io/job": "job-7" } })),
    ).toBe("job-7");
  });

  it("falls back to the pod name for a legacy pod without the label", () => {
    // Pods predating the job label are keyed by their (unstable) pod name.
    expect(podJobName(podFixture({ name: "legacy-pod-xyz", labels: {} }))).toBe(
      "legacy-pod-xyz",
    );
  });

  it("returns 'unknown' when neither the label nor a name is present", () => {
    expect(podJobName({})).toBe("unknown");
  });
});

describe("loadPersistedOutputs", () => {
  // Captures the drizzle IN(...) filter so the "only terminal pods" narrowing —
  // done in JS before the query — is asserted on the params that reach the db.
  function fakeDb(
    rows: unknown[],
    captured?: { sql: string; params: unknown[] }[],
  ) {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: (cond: never) => {
        if (captured) captured.push(new PgDialect().sqlToQuery(cond));
        return Promise.resolve(rows);
      },
    };
    return chain as never;
  }

  it("queries only terminal pods, keys the result by job name, and maps tokens", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const rows = [
      {
        jobName: "job-succeeded",
        pullRequestUrl: "https://github.com/acme/app/pull/1",
        createdIssueUrl: null,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      {
        jobName: "job-failed",
        pullRequestUrl: null,
        createdIssueUrl: "https://github.com/acme/app/issues/2",
        // An un-reported run leaves all four token columns null.
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
      },
    ];

    const byJob = await loadPersistedOutputs(fakeDb(rows, captured), [
      podFixture({
        phase: "Succeeded",
        labels: { "bandolier.io/job": "job-succeeded" },
      }),
      podFixture({
        phase: "Failed",
        labels: { "bandolier.io/job": "job-failed" },
      }),
      podFixture({
        phase: "Running",
        labels: { "bandolier.io/job": "job-running" },
      }),
      podFixture({
        phase: "Pending",
        labels: { "bandolier.io/job": "job-pending" },
      }),
    ]);

    // Only Succeeded/Failed pods reach the IN(...) filter.
    const where = captured[0]!;
    expect(where.sql).toContain('"job_name" in');
    expect(where.params).toEqual(
      expect.arrayContaining(["job-succeeded", "job-failed"]),
    );
    expect(where.params).not.toContain("job-running");
    expect(where.params).not.toContain("job-pending");

    // Result keyed by job name, tokens mapped (present) / nulled (all-null row).
    expect([...byJob.keys()].sort()).toEqual(["job-failed", "job-succeeded"]);
    expect(byJob.get("job-succeeded")).toEqual({
      pullRequestUrl: "https://github.com/acme/app/pull/1",
      createdIssueUrl: null,
      tokens: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    expect(byJob.get("job-failed")).toEqual({
      pullRequestUrl: null,
      createdIssueUrl: "https://github.com/acme/app/issues/2",
      tokens: null,
    });
  });

  it("issues no query and returns an empty map when no pod is terminal", async () => {
    // Running pods have no persisted output yet; a running-only list must not
    // touch the database at all.
    const throwing = {
      select() {
        throw new Error("no query expected");
      },
    } as never;

    const byJob = await loadPersistedOutputs(throwing, [
      podFixture({
        phase: "Running",
        labels: { "bandolier.io/job": "job-running" },
      }),
      podFixture({ phase: "Pending" }),
    ]);

    expect(byJob.size).toBe(0);
  });
});

describe("mergeOutput", () => {
  const logTokens = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 4,
  };
  const persistedTokens = {
    inputTokens: 9,
    outputTokens: 8,
    cacheReadInputTokens: 7,
    cacheCreationInputTokens: 6,
  };

  it("prefers the live log value for every field", () => {
    expect(
      mergeOutput(
        {
          pullRequestUrl: "log-pr",
          createdIssueUrl: "log-issue",
          tokens: logTokens,
        },
        {
          pullRequestUrl: "persisted-pr",
          createdIssueUrl: "persisted-issue",
          tokens: persistedTokens,
        },
      ),
    ).toEqual({
      pullRequestUrl: "log-pr",
      createdIssueUrl: "log-issue",
      tokens: logTokens,
    });
  });

  it("fills each gap from the persisted fallback when the log value is null", () => {
    expect(
      mergeOutput(
        { pullRequestUrl: null, createdIssueUrl: null, tokens: null },
        {
          pullRequestUrl: "persisted-pr",
          createdIssueUrl: "persisted-issue",
          tokens: persistedTokens,
        },
      ),
    ).toEqual({
      pullRequestUrl: "persisted-pr",
      createdIssueUrl: "persisted-issue",
      tokens: persistedTokens,
    });
  });

  it("yields null for a field neither source supplies (no persisted row)", () => {
    expect(
      mergeOutput(
        { pullRequestUrl: null, createdIssueUrl: null, tokens: null },
        undefined,
      ),
    ).toEqual({ pullRequestUrl: null, createdIssueUrl: null, tokens: null });
  });
});

describe("podToTask", () => {
  it("maps a running interactive pod: expiry null, live-log output, awaiting from inspection", async () => {
    const liveTokens = {
      inputTokens: 50,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    inspectPod.mockResolvedValue(
      fullInspection({
        currently: "Writing the fix",
        awaitingInput: true,
        pullRequestUrl: "https://github.com/acme/app/pull/9",
        tokens: liveTokens,
      }),
    );
    const pod = podFixture({
      name: "bandolier-agent-1-abc",
      labels: {
        "bandolier.io/job": "bandolier-agent-1",
        "bandolier.io/spawned-by": "u1",
        "bandolier.io/interactive": "true",
        "bandolier.io/source": "github-issue",
      },
      annotations: {
        "bandolier.io/display-name": "Fix the flaky test",
        "bandolier.io/repo": "acme/app",
      },
      phase: "Running",
      env: [{ name: "CLAUDE_TASK", value: "Fix the flaky test" }],
      creationTimestamp: new Date("2026-07-01T12:00:00Z"),
    });

    const task = await podToTask(
      pod,
      "acme-app",
      "kubeconfig",
      {} as never,
      null,
      Date.now(),
      new Map(),
      "u1",
    );

    expect(task).toMatchObject({
      name: "bandolier-agent-1-abc",
      jobName: "bandolier-agent-1",
      status: "Running",
      // Label matches spawnedByLabelValue("u1") === "u1".
      ownedByViewer: true,
      // Null while running — no terminated container yet.
      expiresAt: null,
      prompt: "Fix the flaky test",
      interactive: true,
      // interactive && inspection.awaitingInput.
      awaitingInput: true,
      currently: "Writing the fix",
      // Live log URL wins over the (empty) persisted fallback.
      pullRequestUrl: "https://github.com/acme/app/pull/9",
      pullRequestState: "open",
      outputType: "pr",
      source: "github-issue",
      displayName: "Fix the flaky test",
      tokens: liveTokens,
      expired: false,
    });
    expect(task.createdAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("derives expiresAt from finishedAt + JOB_TTL_SECONDS and falls back to persisted output", async () => {
    // Logs supplied no URL/tokens (pod's logs gone or a transient read miss).
    inspectPod.mockResolvedValue(
      fullInspection({ currently: null, pullRequestUrl: null, tokens: null }),
    );
    const persistedTokens = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const pod = podFixture({
      name: "bandolier-agent-2-xyz",
      labels: {
        "bandolier.io/job": "bandolier-agent-2",
        "bandolier.io/spawned-by": "u1",
      },
      phase: "Succeeded",
      finishedAt: new Date("2026-07-01T12:00:00Z"),
    });
    const persisted = new Map([
      [
        "bandolier-agent-2",
        {
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          createdIssueUrl: null,
          tokens: persistedTokens,
        },
      ],
    ]);

    const task = await podToTask(
      pod,
      "acme-app",
      "kubeconfig",
      {} as never,
      null,
      Date.now(),
      persisted,
      "u1",
    );

    expect(task.status).toBe("Succeeded");
    // 12:00:00 + 600s = 12:10:00.
    expect(task.expiresAt).toBe("2026-07-01T12:10:00.000Z");
    expect(task.pullRequestUrl).toBe("https://github.com/acme/app/pull/7");
    expect(task.tokens).toEqual(persistedTokens);
    expect(task.expired).toBe(false);
  });

  it("suppresses awaitingInput for a non-interactive pod even when the inspection is awaiting", async () => {
    inspectPod.mockResolvedValue(fullInspection({ awaitingInput: true }));
    const pod = podFixture({
      labels: { "bandolier.io/spawned-by": "u1" },
      phase: "Running",
    });

    const task = await podToTask(
      pod,
      "acme-app",
      "kubeconfig",
      {} as never,
      null,
      Date.now(),
      new Map(),
      "u1",
    );

    expect(task.interactive).toBe(false);
    expect(task.awaitingInput).toBe(false);
  });

  it("reports issue output when the output-type annotation is 'issue'", async () => {
    const pod = podFixture({
      labels: { "bandolier.io/spawned-by": "u1" },
      annotations: { "bandolier.io/output-type": "issue" },
      phase: "Succeeded",
      finishedAt: new Date("2026-07-01T12:00:00Z"),
    });

    const task = await podToTask(
      pod,
      "acme-app",
      "kubeconfig",
      {} as never,
      null,
      Date.now(),
      new Map(),
      "u1",
    );

    expect(task.outputType).toBe("issue");
  });

  it("marks a pod spawned by a different user as not owned, with null prompt/createdAt", async () => {
    const pod = podFixture({
      labels: { "bandolier.io/spawned-by": "u2" },
      phase: "Running",
    });

    const task = await podToTask(
      pod,
      "acme-app",
      "kubeconfig",
      {} as never,
      null,
      Date.now(),
      new Map(),
      "u1",
    );

    expect(task.ownedByViewer).toBe(false);
    // No CLAUDE_TASK env and no creationTimestamp on this pod.
    expect(task.prompt).toBeNull();
    expect(task.createdAt).toBeNull();
  });

  it("surfaces the container failure reason for a Failed pod via the real podFailure", async () => {
    const pod = podFixture({
      labels: { "bandolier.io/spawned-by": "u1" },
      phase: "Failed",
      finishedAt: new Date("2026-07-01T12:00:00Z"),
      terminated: { reason: "OOMKilled", exitCode: 137 },
    });

    const task = await podToTask(
      pod,
      "acme-app",
      "kubeconfig",
      {} as never,
      null,
      Date.now(),
      new Map(),
      "u1",
    );

    expect(task.status).toBe("Failed");
    expect(task.failure).toEqual({
      reason: "OOMKilled",
      exitCode: 137,
      message: null,
    });
  });
});
