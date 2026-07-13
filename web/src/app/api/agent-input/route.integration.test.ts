import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { GET } from "~/app/api/agent-input/route";
import { agentInput } from "~/server/db/schema";
import { bearerIngestToken } from "~/test/integration/auth-material";
import { db, resetDb } from "~/test/integration/harness";

const SECRET = "test-secret";

function inputGet(jobName: string): NextRequest {
  return new NextRequest("http://localhost/api/agent-input", {
    headers: {
      "x-bandolier-job": jobName,
      authorization: bearerIngestToken(jobName, SECRET),
    },
  });
}

describe("harness GET /api/agent-input (real Postgres)", () => {
  beforeEach(resetDb);

  it("drains the oldest undelivered row exactly once via the guarded claim", async () => {
    const job = "job-input";
    await db.insert(agentInput).values([
      {
        id: "i1",
        jobName: job,
        content: "first",
        createdAt: new Date(Date.now() - 2000),
      },
      {
        id: "i2",
        jobName: job,
        content: "second",
        createdAt: new Date(Date.now() - 1000),
      },
    ]);

    const res1 = await GET(inputGet(job));
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ id: "i1", content: "first" });

    // The claimed row is marked delivered — it never comes back.
    const res2 = await GET(inputGet(job));
    expect(await res2.json()).toMatchObject({ id: "i2", content: "second" });

    // Queue drained → 204.
    const res3 = await GET(inputGet(job));
    expect(res3.status).toBe(204);

    // Both rows now carry a deliveredAt.
    const rows = await db
      .select()
      .from(agentInput)
      .where(eq(agentInput.jobName, job));
    expect(rows.every((r) => r.deliveredAt !== null)).toBe(true);
  });

  it("scopes the claim to the polling job — another job's input is untouched", async () => {
    await db.insert(agentInput).values([
      { id: "mine", jobName: "job-a", content: "for A" },
      { id: "theirs", jobName: "job-b", content: "for B" },
    ]);

    const res = await GET(inputGet("job-a"));
    expect(await res.json()).toMatchObject({ id: "mine" });

    // job-b's row remains undelivered.
    const [others] = await db
      .select()
      .from(agentInput)
      .where(eq(agentInput.jobName, "job-b"));
    expect(others!.deliveredAt).toBeNull();
  });

  it("rejects an unauthenticated poll with 401", async () => {
    const req = new NextRequest("http://localhost/api/agent-input", {
      headers: { "x-bandolier-job": "job-x", authorization: "Bearer nope" },
    });
    expect((await GET(req)).status).toBe(401);
  });
});
