import { and, desc, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import type { JobSpec } from "~/server/agents/create-job";
import { pendingAgentRun } from "~/server/db/schema";

// The pending-run store is plain drizzle over `pendingAgentRun`, so we fake the
// query chains on a `typeof db`-cast stub. `createAgentJob` is mocked because
// its module reaches the real DB / Kubernetes clients at import time — and
// because dispatch must be observed at that boundary anyway.
const createAgentJob = vi.fn<(spec: JobSpec) => Promise<string>>();

vi.mock("~/server/agents/create-job", () => ({
  createAgentJob: (spec: JobSpec) => createAgentJob(spec),
}));

const {
  storePendingRun,
  setApprovalCommentId,
  getUnresolvedPendingRun,
  markResolved,
  dispatchPendingRun,
} = await import("~/server/agents/agent-approval");

// Minimal-but-valid job spec; approval must replay it byte-for-byte. The
// kubeconfig stands in for the resolved repo credentials the row holds.
const spec: JobSpec = {
  task: "Fix the flaky test",
  displayName: "Fix the flaky test",
  branch: "main",
  model: "claude-sonnet-4-5",
  issueNumber: "12",
  userId: "u1",
  kubeconfig: "kc-yaml",
};

function makeInsertDb() {
  const values = vi
    .fn<(v: Record<string, unknown>) => Promise<void>>()
    .mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return { database: { insert } as unknown as typeof Database, values };
}

function makeUpdateDb() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { database: { update } as unknown as typeof Database, set, where };
}

function makeUpdateReturningDb(rows: { id: string }[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn((_values: Record<string, unknown>) => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { database: { update } as unknown as typeof Database, set, where };
}

function makeSelectDb(rows: Record<string, unknown>[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    database: { select } as unknown as typeof Database,
    where,
    orderBy,
  };
}

beforeEach(() => {
  createAgentJob.mockReset();
});

describe("storePendingRun", () => {
  it("inserts the run under a fresh UUID with the spec serialized verbatim", async () => {
    const { database, values } = makeInsertDb();
    const id = await storePendingRun(database, {
      repoFullName: "o/r",
      issueNumber: 12,
      requestedByLogin: "newcomer",
      spec,
    });

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(values).toHaveBeenCalledTimes(1);
    const inserted = values.mock.calls[0]![0];
    expect(inserted).toEqual({
      id,
      repoFullName: "o/r",
      issueNumber: 12,
      requestedByLogin: "newcomer",
      payload: JSON.stringify(spec),
    });
    // The payload round-trips to the exact spec that was gated.
    expect(JSON.parse(inserted.payload as string)).toEqual(spec);
  });
});

describe("setApprovalCommentId", () => {
  it("stamps the bot comment id onto the run's row", async () => {
    const { database, set, where } = makeUpdateDb();
    await setApprovalCommentId(database, "run-1", "c-123");

    expect(set).toHaveBeenCalledWith({ approvalCommentId: "c-123" });
    expect(where).toHaveBeenCalledWith(eq(pendingAgentRun.id, "run-1"));
  });
});

describe("getUnresolvedPendingRun", () => {
  it("returns null when the issue has no unresolved run", async () => {
    const { database } = makeSelectDb([]);
    expect(await getUnresolvedPendingRun(database, "o/r", 12)).toBeNull();
  });

  it("queries only unresolved rows for the issue, newest first", async () => {
    const { database, where, orderBy } = makeSelectDb([]);
    await getUnresolvedPendingRun(database, "o/r", 12);

    // The resolvedAt IS NULL clause is what keeps dispatched runs invisible.
    expect(where).toHaveBeenCalledWith(
      and(
        eq(pendingAgentRun.repoFullName, "o/r"),
        eq(pendingAgentRun.issueNumber, 12),
        isNull(pendingAgentRun.resolvedAt),
      ),
    );
    expect(orderBy).toHaveBeenCalledWith(desc(pendingAgentRun.createdAt));
  });

  it("maps the row back into a PendingRun, parsing the spec out of the payload", async () => {
    const { database } = makeSelectDb([
      {
        id: "run-1",
        repoFullName: "o/r",
        issueNumber: 12,
        requestedByLogin: "newcomer",
        approvalCommentId: null,
        payload: JSON.stringify(spec),
        createdAt: new Date("2026-01-02T03:04:05Z"),
      },
    ]);
    const run = await getUnresolvedPendingRun(database, "o/r", 12);

    expect(run).toEqual({
      id: "run-1",
      repoFullName: "o/r",
      issueNumber: 12,
      requestedByLogin: "newcomer",
      approvalCommentId: null,
      spec,
    });
  });

  it("passes a recorded approval comment id through", async () => {
    const { database } = makeSelectDb([
      {
        id: "run-2",
        repoFullName: "o/r",
        issueNumber: 12,
        requestedByLogin: "newcomer",
        approvalCommentId: "c-9",
        payload: JSON.stringify(spec),
      },
    ]);
    const run = await getUnresolvedPendingRun(database, "o/r", 12);
    expect(run?.approvalCommentId).toBe("c-9");
  });
});

describe("markResolved", () => {
  it("claims an unresolved row and stamps the resolution audit trail", async () => {
    const { database, set, where } = makeUpdateReturningDb([{ id: "run-1" }]);
    const claimed = await markResolved(
      database,
      "run-1",
      "dispatched",
      "maintainer",
    );

    expect(claimed).toBe(true);
    const stamped = set.mock.calls[0]![0];
    expect(stamped.resolution).toBe("dispatched");
    expect(stamped.resolvedByLogin).toBe("maintainer");
    expect(stamped.resolvedAt).toBeInstanceOf(Date);
    // The update itself must exclude already-resolved rows — that IS NULL guard
    // is what makes two racing approvals resolve the run exactly once.
    expect(where).toHaveBeenCalledWith(
      and(eq(pendingAgentRun.id, "run-1"), isNull(pendingAgentRun.resolvedAt)),
    );
  });

  it("returns false when the row was already resolved (no re-claim)", async () => {
    const { database } = makeUpdateReturningDb([]);
    expect(await markResolved(database, "run-1", "declined", "other")).toBe(
      false,
    );
  });
});

describe("dispatchPendingRun", () => {
  it("replays the stored spec through createAgentJob and returns the job name", async () => {
    createAgentJob.mockResolvedValue("job-abc");
    const run = {
      id: "run-1",
      repoFullName: "o/r",
      issueNumber: 12,
      requestedByLogin: "newcomer",
      approvalCommentId: "c-9",
      spec,
    };

    expect(await dispatchPendingRun(run)).toBe("job-abc");
    expect(createAgentJob).toHaveBeenCalledTimes(1);
    // The exact stored spec object is replayed, not a re-derived subset.
    expect(createAgentJob.mock.calls[0]![0]).toBe(spec);
  });
});
