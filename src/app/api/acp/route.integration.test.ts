import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "~/app/api/acp/route";
import { acpFrame } from "~/server/db/schema";
import { bearerIngestToken } from "~/test/integration/auth-material";
import { db, resetDb } from "~/test/integration/harness";

const SECRET = "test-secret";

function acpGet(jobName: string): NextRequest {
  return new NextRequest("http://localhost/api/acp", {
    headers: {
      "x-bandolier-job": jobName,
      authorization: bearerIngestToken(jobName, SECRET),
    },
  });
}

function acpPost(jobName: string, frames: string[]): NextRequest {
  return new NextRequest("http://localhost/api/acp", {
    method: "POST",
    headers: {
      "x-bandolier-job": jobName,
      authorization: bearerIngestToken(jobName, SECRET),
      "content-type": "application/json",
    },
    body: JSON.stringify({ frames }),
  });
}

describe("harness /api/acp relay (real Postgres)", () => {
  beforeEach(resetDb);

  it("POST appends a2c frames in order as real rows", async () => {
    const job = "job-acp";
    const res = await POST(acpPost(job, ["frameA", "frameB"]));
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(acpFrame)
      .where(and(eq(acpFrame.jobName, job), eq(acpFrame.direction, "a2c")))
      .orderBy(asc(acpFrame.seq));
    expect(rows.map((r) => r.payload)).toEqual(["frameA", "frameB"]);
  });

  it("GET claims queued c2a frames oldest-first, exactly once", async () => {
    const job = "job-acp";
    // Seed client→agent frames (what the harness pulls).
    await db.insert(acpFrame).values([
      { jobName: job, direction: "c2a", payload: "c2a-1" },
      { jobName: job, direction: "c2a", payload: "c2a-2" },
    ]);

    const res = await GET(acpGet(job));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      frames: { seq: number; payload: string }[];
    };
    expect(body.frames.map((f) => f.payload)).toEqual(["c2a-1", "c2a-2"]);
    // bigserial seq is monotonic → oldest-first ordering is real, not incidental.
    expect(body.frames[0]!.seq).toBeLessThan(body.frames[1]!.seq);

    // Claimed → the next poll is empty (204), proving exactly-once delivery.
    const res2 = await GET(acpGet(job));
    expect(res2.status).toBe(204);

    // The rows are marked delivered.
    const rows = await db
      .select()
      .from(acpFrame)
      .where(and(eq(acpFrame.jobName, job), eq(acpFrame.direction, "c2a")));
    expect(rows.every((r) => r.deliveredAt !== null)).toBe(true);
  });

  it("does not deliver another job's frames", async () => {
    await db.insert(acpFrame).values([
      { jobName: "job-a", direction: "c2a", payload: "for-a" },
      { jobName: "job-b", direction: "c2a", payload: "for-b" },
    ]);
    const res = await GET(acpGet("job-a"));
    const body = (await res.json()) as { frames: { payload: string }[] };
    expect(body.frames.map((f) => f.payload)).toEqual(["for-a"]);
  });

  it("rejects a malformed frames body with 400", async () => {
    const req = new NextRequest("http://localhost/api/acp", {
      method: "POST",
      headers: {
        "x-bandolier-job": "job-x",
        authorization: bearerIngestToken("job-x", SECRET),
        "content-type": "application/json",
      },
      body: JSON.stringify({ frames: [1, 2, 3] }),
    });
    expect((await POST(req)).status).toBe(400);
  });
});
