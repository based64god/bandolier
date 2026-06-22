import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { verifyIngestToken } from "~/lib/ingest";
import {
  artifactsEnabled,
  putArtifact,
  transcriptKey,
} from "~/server/agents/artifacts";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";

// Harness callback: receives a finished run's rendered transcript and stores it
// in object storage, recording the key on the run. Authenticated by a per-job
// HMAC token (the harness can't hold a session), not the password gate.
export async function POST(req: NextRequest) {
  if (!artifactsEnabled()) {
    return NextResponse.json({ error: "Artifacts disabled" }, { status: 503 });
  }

  const jobName = req.headers.get("x-bandolier-job");
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (
    !jobName ||
    !token ||
    !verifyIngestToken(jobName, token, env.BETTER_AUTH_SECRET)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const transcript = await req.text();
  const key = transcriptKey(jobName);

  try {
    await putArtifact(key, transcript);
  } catch (err) {
    console.error("[bandolier:ingest] upload failed", {
      job: jobName,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  // The run's structured output, reported by the harness. Persisting it makes a
  // finished run's output recoverable from the database after the pod (and its
  // logs, where this is otherwise re-derived) are gone.
  const pullRequestUrl = req.headers.get("x-bandolier-pr-url");
  const createdIssueUrl = req.headers.get("x-bandolier-issue-url");

  // Record the key and output (no-op if the run row was pruned).
  await db
    .update(taskRun)
    .set({
      transcriptKey: key,
      ...(pullRequestUrl && { pullRequestUrl }),
      ...(createdIssueUrl && { createdIssueUrl }),
      updatedAt: new Date(),
    })
    .where(eq(taskRun.jobName, jobName));

  console.log("[bandolier:ingest] transcript stored", {
    job: jobName,
    bytes: transcript.length,
  });
  return NextResponse.json({ ok: true });
}
