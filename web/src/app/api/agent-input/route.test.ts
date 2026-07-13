import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingestToken } from "~/lib/ingest";

// The handler is pure request→db glue: mock the database and drive the exported
// GET with real NextRequest objects. Auth stays real (the vitest env sets
// BETTER_AUTH_SECRET, so a token from ingestToken verifies). The db mock
// exposes the two chains the handler uses — the select for the next queued
// message and the guarded claim update whose `.returning()` decides 200 vs 204.

// select(...).from().where().orderBy().limit() → the next-message rows.
const selectRows = vi.fn<() => Promise<unknown[]>>();
// update(...).set().where().returning() → the claimed rows (empty = lost race).
const claimReturning = vi.fn<() => Promise<unknown[]>>();

vi.mock("~/server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => selectRows() }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => claimReturning() }),
      }),
    }),
  },
}));

import { GET } from "./route";

const SECRET = "test-secret";
const JOB = "job-1";

function authHeaders(job = JOB): Record<string, string> {
  return {
    "x-bandolier-job": job,
    authorization: `Bearer ${ingestToken(job, SECRET)}`,
  };
}

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://bandolier.test/api/agent-input", { headers });
}

beforeEach(() => {
  selectRows.mockReset().mockResolvedValue([]);
  claimReturning.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent-input GET (claim next queued user message)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await GET(request({}));
    expect(res.status).toBe(401);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("returns 204 without claiming when the queue is empty", async () => {
    selectRows.mockResolvedValueOnce([]);

    const res = await GET(request(authHeaders()));

    expect(res.status).toBe(204);
    expect(claimReturning).not.toHaveBeenCalled();
  });

  it("returns the claimed message when it wins the claim", async () => {
    selectRows.mockResolvedValueOnce([{ id: "m1" }]);
    claimReturning.mockResolvedValueOnce([{ id: "m1", content: "hello" }]);

    const res = await GET(request(authHeaders()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "m1", content: "hello" });
  });

  it("returns 204 (not 500) when the guarded claim loses a concurrent race", async () => {
    // A message was visible, but the update matched no row — another claim beat
    // this one. The guard must degrade to 204, never double-deliver or throw.
    selectRows.mockResolvedValueOnce([{ id: "m1" }]);
    claimReturning.mockResolvedValueOnce([]);

    const res = await GET(request(authHeaders()));

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});
