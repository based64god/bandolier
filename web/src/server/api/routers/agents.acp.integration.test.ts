import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthzModule from "~/server/agents/authz";

// The router's ACP relay procedures against a REAL Postgres: acpSend inserts a
// real c2a frame, and acpPull paginates real acp_frame rows by the bigserial
// cursor while deciding visibility from a REAL task_run row. Only the authz
// guards (assertRepoAccess / assertOwnsInteractiveJob — covered by their own
// unit tests) are stubbed; the mayViewRun decision and the ORDER BY/LIMIT/cursor
// SQL run for real, which a fluent-stub fakeDb cannot verify.
const assertRepoAccess = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const assertOwnsInteractiveJob = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock("~/server/agents/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  assertRepoAccess: (...a: unknown[]) => assertRepoAccess(...(a as [])),
  assertOwnsInteractiveJob: (...a: unknown[]) =>
    assertOwnsInteractiveJob(...(a as [])),
}));

const { agentsRouter } = await import("~/server/api/routers/agents");
const { createCallerFactory } = await import("~/server/api/trpc");
const { acpFrame } = await import("~/server/db/schema");
const { db, resetDb, testCtx } = await import("~/test/integration/harness");
const { seedTaskRun, seedUser } = await import("~/test/integration/seed");

const createCaller = createCallerFactory(agentsRouter);
const caller = (user: { id: string }) => createCaller(testCtx(user));

describe("agents ACP relay (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    assertRepoAccess.mockClear().mockResolvedValue(undefined);
    assertOwnsInteractiveJob.mockClear().mockResolvedValue(undefined);
  });

  it("acpSend inserts a real client→agent frame", async () => {
    const u = await seedUser();
    const res = await caller(u).acpSend({
      namespace: "agents",
      jobName: "job-1",
      frame: '{"jsonrpc":"2.0","method":"session/prompt"}',
      repoFullName: "o/r",
    });
    expect(res).toEqual({ success: true });

    const rows = await db
      .select()
      .from(acpFrame)
      .where(and(eq(acpFrame.jobName, "job-1"), eq(acpFrame.direction, "c2a")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toContain("session/prompt");
    expect(assertOwnsInteractiveJob).toHaveBeenCalledTimes(1);
  });

  it("acpPull paginates by the bigserial cursor, oldest-first", async () => {
    const u = await seedUser();
    // The run belongs to this user → mayViewRun is true, so the ownership
    // fallback is never consulted.
    await seedTaskRun({ jobName: "job-pg", spawnedBy: u.id, repoFullName: "o/r" });

    // 600 agent→client frames; bigserial seq is assigned in insert order and
    // RESTART IDENTITY (resetDb) makes it start at 1, so ordering is deterministic.
    await db.insert(acpFrame).values(
      Array.from({ length: 600 }, (_, i) => ({
        jobName: "job-pg",
        direction: "a2c",
        payload: `frame-${i + 1}`,
      })),
    );

    const page1 = await caller(u).acpPull({
      namespace: "agents",
      jobName: "job-pg",
      cursor: 0,
      repoFullName: "o/r",
    });
    expect(page1.frames).toHaveLength(500); // the LIMIT
    expect(page1.frames[0]!.payload).toBe("frame-1");
    expect(page1.frames[499]!.payload).toBe("frame-500");
    expect(page1.cursor).toBe(page1.frames[499]!.seq);
    expect(assertOwnsInteractiveJob).not.toHaveBeenCalled();

    const page2 = await caller(u).acpPull({
      namespace: "agents",
      jobName: "job-pg",
      cursor: page1.cursor,
      repoFullName: "o/r",
    });
    expect(page2.frames).toHaveLength(100); // the remainder
    expect(page2.frames[0]!.payload).toBe("frame-501");
    expect(page2.frames[99]!.payload).toBe("frame-600");

    // A cursor past the end returns nothing and holds the cursor.
    const page3 = await caller(u).acpPull({
      namespace: "agents",
      jobName: "job-pg",
      cursor: page2.cursor,
      repoFullName: "o/r",
    });
    expect(page3.frames).toHaveLength(0);
    expect(page3.cursor).toBe(page2.cursor);
  });

  it("acpPull authorizes a collaborator via the run's repoFullName, and falls back otherwise", async () => {
    const owner = await seedUser();
    const collaborator = await seedUser();
    // Run owned by `owner`, bound to repo o/r.
    await seedTaskRun({
      jobName: "job-collab",
      spawnedBy: owner.id,
      repoFullName: "o/r",
    });
    await db.insert(acpFrame).values({
      jobName: "job-collab",
      direction: "a2c",
      payload: "hello",
    });

    // Collaborator queries with the matching repoFullName → mayViewRun true, so
    // the interactive-job ownership fallback is NOT consulted.
    const asCollab = await caller(collaborator).acpPull({
      namespace: "agents",
      jobName: "job-collab",
      cursor: 0,
      repoFullName: "o/r",
    });
    expect(asCollab.frames).toHaveLength(1);
    expect(assertOwnsInteractiveJob).not.toHaveBeenCalled();

    // A different repo (not owner, no repo match) → mayViewRun false → the
    // procedure falls through to the ownership check (here stubbed to reject).
    assertOwnsInteractiveJob.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { code: "FORBIDDEN" }),
    );
    await expect(
      caller(collaborator).acpPull({
        namespace: "agents",
        jobName: "job-collab",
        cursor: 0,
        repoFullName: "other/repo",
      }),
    ).rejects.toThrow();
    expect(assertOwnsInteractiveJob).toHaveBeenCalledTimes(1);
  });
});
