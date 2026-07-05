import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingestToken } from "~/lib/ingest";
import type { PushPayload } from "~/server/push";

// The relay handlers are pure request→db glue, so mock the two I/O boundaries
// they touch — the database and the push sender — and drive the exported GET/
// POST with real NextRequest objects. Auth stays real: the vitest env sets
// BETTER_AUTH_SECRET, so a token from the real ingestToken verifies. The db
// mock exposes the fluent chains the handlers use; terminal methods defer to
// top-level vi.fn()s (through arrows, to dodge hoisting TDZ) that each test
// primes with the rows to return.

// select(...).from().where().orderBy?().limit() → the queued rows.
const selectRows = vi.fn<() => Promise<unknown[]>>();
// update(...).set().where() is awaited directly (no returning) in this route.
const updateWhere = vi.fn<() => Promise<unknown>>();
// insert(...).values(rows) — spied so tests can assert what got appended.
const insertValues = vi.fn<(rows: unknown) => void>();

vi.mock("~/server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => selectRows() }),
          limit: () => selectRows(),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        // where() is awaited by GET's claim; make it a thenable so `await` works.
        where: () => Promise.resolve(updateWhere()),
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        insertValues(rows);
        return Promise.resolve();
      },
    }),
  },
}));

const sendPush =
  vi.fn<(userId: string, payload: PushPayload) => Promise<void>>();
vi.mock("~/server/push", () => ({
  sendPushToUser: (userId: string, payload: PushPayload) =>
    sendPush(userId, payload),
}));

import { GET, POST } from "./route";

const SECRET = "test-secret";
const JOB = "job-1";

function authHeaders(job = JOB): Record<string, string> {
  return {
    "x-bandolier-job": job,
    authorization: `Bearer ${ingestToken(job, SECRET)}`,
  };
}

function getRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://bandolier.test/api/acp", { headers });
}

function postRequest(
  body: unknown,
  headers: Record<string, string>,
  raw?: string,
): NextRequest {
  return new NextRequest("http://bandolier.test/api/acp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

/** A completed prompt turn (stopReason present) — the await trigger. */
function turnEndFrame(stopReason = "end_turn"): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason } });
}

beforeEach(() => {
  selectRows.mockReset().mockResolvedValue([]);
  updateWhere.mockReset().mockResolvedValue(undefined);
  insertValues.mockReset();
  sendPush.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ACP relay GET (claim client→agent frames)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await GET(getRequest({}));
    expect(res.status).toBe(401);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("returns queued frames oldest-first and marks them delivered", async () => {
    const rows = [
      { seq: 1, payload: "a" },
      { seq: 2, payload: "b" },
    ];
    selectRows.mockResolvedValueOnce(rows);

    const res = await GET(getRequest(authHeaders()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ frames: rows });
    // The claim (mark delivered) update ran for this poll.
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it("returns 204 and skips the claim update when the queue is empty", async () => {
    selectRows.mockResolvedValueOnce([]);

    const res = await GET(getRequest(authHeaders()));

    expect(res.status).toBe(204);
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("delivers each frame exactly once: a second poll of a drained queue → 204", async () => {
    selectRows
      .mockResolvedValueOnce([{ seq: 1, payload: "a" }])
      .mockResolvedValueOnce([]);

    const first = await GET(getRequest(authHeaders()));
    expect(first.status).toBe(200);
    expect(updateWhere).toHaveBeenCalledTimes(1);

    const second = await GET(getRequest(authHeaders()));
    expect(second.status).toBe(204);
    // No second claim — nothing was re-delivered.
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });
});

describe("ACP relay POST (append agent→client frames)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await POST(postRequest({ frames: ["x"] }, {}));
    expect(res.status).toBe(401);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(postRequest(undefined, authHeaders(), "{not json"));
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects a non-array frames field with 400", async () => {
    const res = await POST(postRequest({ frames: "nope" }, authHeaders()));
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects frames containing a non-string element with 400", async () => {
    const res = await POST(postRequest({ frames: ["ok", 42] }, authHeaders()));
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("accepts an empty array without inserting anything", async () => {
    const res = await POST(postRequest({ frames: [] }, authHeaders()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("appends string frames as a2c rows for the job", async () => {
    const res = await POST(
      postRequest({ frames: ["f1", "f2"] }, authHeaders()),
    );

    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith([
      { jobName: JOB, direction: "a2c", payload: "f1" },
      { jobName: JOB, direction: "a2c", payload: "f2" },
    ]);
  });

  it("fires an awaiting-input push when the batch contains a turn-end frame", async () => {
    selectRows.mockResolvedValueOnce([
      { spawnedBy: "user-1", displayName: "My run", repoFullName: "acme/app" },
    ]);

    const res = await POST(
      postRequest({ frames: ["chunk", turnEndFrame()] }, authHeaders()),
    );
    expect(res.status).toBe(200);

    // The notify is fire-and-forget off the response path; wait for it.
    await vi.waitFor(() => expect(sendPush).toHaveBeenCalledTimes(1));
    expect(sendPush).toHaveBeenCalledWith("user-1", {
      title: "Agent waiting for input",
      body: "My run",
      tag: `await:${JOB}`,
      url: "/repo/acme/app",
    });
  });

  it("does not push when no frame ends a turn", async () => {
    const res = await POST(
      postRequest({ frames: ["chunk", "another-chunk"] }, authHeaders()),
    );
    expect(res.status).toBe(200);

    // Let any stray microtasks settle, then assert no push was attempted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("does not push on a cancelled turn (nothing to alert about)", async () => {
    selectRows.mockResolvedValueOnce([
      { spawnedBy: "user-1", displayName: "My run", repoFullName: null },
    ]);

    const res = await POST(
      postRequest({ frames: [turnEndFrame("cancelled")] }, authHeaders()),
    );
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendPush).not.toHaveBeenCalled();
  });
});
