import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { POST } from "~/app/api/agent-runs/route";
import { taskRun } from "~/server/db/schema";
import { bearerIngestToken } from "~/test/integration/auth-material";
import { db, resetDb } from "~/test/integration/harness";
import { seedTaskRun } from "~/test/integration/seed";

// The ingest route verifies the per-job token against env.BETTER_AUTH_SECRET,
// which the integration config sets to this value.
const SECRET = "test-secret";

function ingestPost(
  jobName: string,
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/agent-runs", {
    method: "POST",
    headers: {
      "x-bandolier-job": jobName,
      authorization: bearerIngestToken(jobName, SECRET),
      "content-type": "text/plain",
      ...headers,
    },
    body,
  });
}

describe("harness /api/agent-runs ingest (real Postgres)", () => {
  beforeEach(resetDb);

  it("persists output columns via a valid partial UPDATE...WHERE job_name", async () => {
    const run = await seedTaskRun({ spawnedBy: null });

    const res = await POST(
      ingestPost(run.jobName, "the transcript body", {
        "x-bandolier-status": "Succeeded",
        "x-bandolier-pr-url": "https://github.com/o/r/pull/9",
        "x-bandolier-tokens":
          '{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":0}',
        "x-bandolier-harness-contract": "3",
      }),
    );
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(taskRun)
      .where(eq(taskRun.jobName, run.jobName));
    expect(row!.status).toBe("Succeeded");
    expect(row!.pullRequestUrl).toBe("https://github.com/o/r/pull/9");
    expect(row!.inputTokens).toBe(100);
    expect(row!.outputTokens).toBe(20);
    expect(row!.cacheReadInputTokens).toBe(5);
    expect(row!.harnessContract).toBe(3);
    // A column the callback didn't set stays untouched.
    expect(row!.createdIssueUrl).toBeNull();
  });

  it("records the unreported-contract sentinel when the header is absent", async () => {
    const run = await seedTaskRun();
    await POST(ingestPost(run.jobName, "x", { "x-bandolier-status": "Failed" }));

    const [row] = await db
      .select()
      .from(taskRun)
      .where(eq(taskRun.jobName, run.jobName));
    expect(row!.status).toBe("Failed");
    // Absent contract header → 0 (unreported), never left null.
    expect(row!.harnessContract).toBe(0);
  });

  it("is a no-op UPDATE (still 200) when the run row was pruned", async () => {
    const res = await POST(
      ingestPost("job-does-not-exist", "orphan transcript", {
        "x-bandolier-status": "Succeeded",
      }),
    );
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(taskRun)
      .where(eq(taskRun.jobName, "job-does-not-exist"));
    expect(rows).toHaveLength(0);
  });

  it("rejects a forged token with 401 and writes nothing", async () => {
    const run = await seedTaskRun();
    const req = new NextRequest("http://localhost/api/agent-runs", {
      method: "POST",
      headers: {
        "x-bandolier-job": run.jobName,
        authorization: "Bearer forged",
      },
      body: "x",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);

    const [row] = await db
      .select()
      .from(taskRun)
      .where(eq(taskRun.jobName, run.jobName));
    expect(row!.status).toBeNull();
  });
});
