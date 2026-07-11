import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Pulled in transitively (inspectPod → k8s client; create-job → env). Only
// JOB_TTL_SECONDS and inspectPod are referenced by the module under test, and
// neither by the functions exercised here.
vi.mock("~/server/agents/pod-inspection", () => ({
  inspectPod: () => Promise.resolve({}),
}));
vi.mock("~/server/agents/create-job", () => ({ JOB_TTL_SECONDS: 600 }));

const { expiredRunToTask, loadExpiredRuns } =
  await import("~/server/agents/task-view");

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

beforeEach(() => {
  resolvePollToken.mockReset().mockResolvedValue(null);
  resolveItemStates.mockReset().mockResolvedValue({
    pullRequestState: "open",
    createdIssueState: null,
    issueState: null,
  });
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
