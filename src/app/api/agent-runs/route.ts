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

// Harness callback: receives a finished run's structured output (its PR/issue
// URL) and rendered transcript. The output is always recorded on the run row so
// it survives the pod's logs; the transcript is additionally stored in object
// storage when a bucket is configured. Authenticated by a per-job HMAC token
// (the harness can't hold a session), not the password gate.
//
// Persisting the output is the primary, unconditional job here. Pod logs are the
// live source of a run's PR/issue link, but they vanish with the pod (TTL
// deletion, eviction, node loss). This callback runs for every run — even
// without S3 — so the link is recoverable from the database afterward. Gating
// the whole endpoint on artifact storage (as it once was) meant a deployment
// without S3 lost its output the moment its pod logs went away.
export async function POST(req: NextRequest) {
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

  // Store the transcript in object storage when configured. Failure here is
  // logged but must not abort the request: the output persistence below is the
  // part that protects against log loss, so it has to happen regardless.
  let key: string | null = null;
  if (artifactsEnabled()) {
    const candidate = transcriptKey(jobName);
    try {
      await putArtifact(candidate, transcript);
      key = candidate;
    } catch (err) {
      console.error("[bandolier:ingest] upload failed", {
        job: jobName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The run's structured output, reported by the harness. Persisting it makes a
  // finished run's output recoverable from the database after the pod (and its
  // logs, where this is otherwise re-derived) are gone.
  const pullRequestUrl = req.headers.get("x-bandolier-pr-url");
  const createdIssueUrl = req.headers.get("x-bandolier-issue-url");

  // Record the output (and transcript key, if uploaded). No-op if the run row
  // was pruned.
  await db
    .update(taskRun)
    .set({
      ...(key && { transcriptKey: key }),
      ...(pullRequestUrl && { pullRequestUrl }),
      ...(createdIssueUrl && { createdIssueUrl }),
      updatedAt: new Date(),
    })
    .where(eq(taskRun.jobName, jobName));

  console.log("[bandolier:ingest] run output stored", {
    job: jobName,
    transcriptStored: key !== null,
    bytes: transcript.length,
  });
  return NextResponse.json({ ok: true });
}
