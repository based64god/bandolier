import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { HARNESS_CONTRACT_UNREPORTED } from "~/lib/harness-contract";
import { verifyIngestToken } from "~/lib/ingest";
import { parseTokenMarkerPayload } from "~/lib/tokens";
import {
  getArtifact,
  putArtifact,
  resolveArtifactStore,
  transcriptKey,
} from "~/server/agents/artifacts";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import { sendPushToUser } from "~/server/push";

/**
 * Authenticates a harness callback by its per-job HMAC token, returning the
 * job name or null. Shared by the ingest POST and the parent-context GET.
 */
function authenticatedJob(req: NextRequest): string | null {
  const jobName = req.headers.get("x-bandolier-job");
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (
    !jobName ||
    !token ||
    !verifyIngestToken(jobName, token, env.BETTER_AUTH_SECRET)
  ) {
    return null;
  }
  return jobName;
}

// Harness callback: serves the calling run's parent transcript, so a resumed
// run (a follow-up comment on its parent's issue or PR) starts with the full
// context of the run it continues. The parent is resolved server-side from the
// run row — the harness only proves it is the job it claims to be (the same
// per-job HMAC the ingest POST uses), so it can never fetch an arbitrary run's
// transcript. 404s (no parent, pruned rows, no artifact store, missing object)
// all mean "no context"; the harness proceeds without it.
export async function GET(req: NextRequest) {
  const jobName = authenticatedJob(req);
  if (!jobName) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [run] = await db
    .select({ parentJobName: taskRun.parentJobName })
    .from(taskRun)
    .where(eq(taskRun.jobName, jobName))
    .limit(1);
  if (!run?.parentJobName) {
    return NextResponse.json({ error: "No parent run" }, { status: 404 });
  }

  const [parent] = await db
    .select({
      transcriptKey: taskRun.transcriptKey,
      repoFullName: taskRun.repoFullName,
    })
    .from(taskRun)
    .where(eq(taskRun.jobName, run.parentJobName))
    .limit(1);
  if (!parent?.transcriptKey) {
    return NextResponse.json(
      { error: "No parent transcript" },
      { status: 404 },
    );
  }

  const store = await resolveArtifactStore(db, parent.repoFullName);
  const transcript = store
    ? await getArtifact(store, parent.transcriptKey)
    : null;
  if (transcript === null) {
    return NextResponse.json(
      { error: "No parent transcript" },
      { status: 404 },
    );
  }
  return new NextResponse(transcript, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Harness callback: receives a finished run's structured output (its PR/issue
// URL) and rendered transcript. The output is always recorded on the run row so
// it survives the pod's logs; the transcript is additionally stored in object
// storage when the run's repo has configured its own artifact bucket (the only
// store — the repo owns its run data). Authenticated by a per-job HMAC token
// (the harness can't hold a session), not the password gate.
//
// Persisting the output is the primary, unconditional job here. Pod logs are the
// live source of a run's PR/issue link, but they vanish with the pod (TTL
// deletion, eviction, node loss). This callback runs for every run — even
// without S3 — so the link is recoverable from the database afterward. Gating
// the whole endpoint on artifact storage (as it once was) meant a deployment
// without S3 lost its output the moment its pod logs went away.
export async function POST(req: NextRequest) {
  const jobName = authenticatedJob(req);
  if (!jobName) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const transcript = await req.text();

  // The run row names the repo, which decides where its transcript lives, plus
  // who to notify (spawnedBy) and how to label the alert. A pruned row (or a
  // repo-less run) means no store, so no upload.
  const [run] = await db
    .select({
      repoFullName: taskRun.repoFullName,
      spawnedBy: taskRun.spawnedBy,
      displayName: taskRun.displayName,
    })
    .from(taskRun)
    .where(eq(taskRun.jobName, jobName))
    .limit(1);

  // Store the transcript in object storage when configured. Failure here is
  // logged but must not abort the request: the output persistence below is the
  // part that protects against log loss, so it has to happen regardless.
  let key: string | null = null;
  const store = await resolveArtifactStore(db, run?.repoFullName ?? null);
  if (store) {
    const candidate = transcriptKey(jobName);
    try {
      await putArtifact(store, candidate, transcript);
      key = candidate;
    } catch (err) {
      console.error("[bandolier:ingest] upload failed", {
        job: jobName,
        bucket: store.bucket,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The run's structured output, reported by the harness. Persisting it makes a
  // finished run's output recoverable from the database after the pod (and its
  // logs, where this is otherwise re-derived) are gone.
  const pullRequestUrl = req.headers.get("x-bandolier-pr-url");
  const createdIssueUrl = req.headers.get("x-bandolier-issue-url");

  // The run's final token usage, reported as the harness's token-marker JSON.
  // Persisting it keeps the readout recoverable after the pod (and its logs,
  // where it's otherwise re-derived) are gone.
  const tokensHeader = req.headers.get("x-bandolier-tokens");
  const tokens = tokensHeader ? parseTokenMarkerPayload(tokensHeader) : null;

  // The harness's server↔harness contract version. This callback arriving at
  // all proves a harness ran, so an absent/garbled header is recorded as
  // "unreported" (a build predating version reporting — certainly stale)
  // rather than left null, which is reserved for "no callback yet".
  const contractHeader = req.headers.get("x-bandolier-harness-contract");
  const parsedContract = contractHeader ? parseInt(contractHeader, 10) : NaN;
  const harnessContract =
    Number.isFinite(parsedContract) && parsedContract > 0
      ? parsedContract
      : HARNESS_CONTRACT_UNREPORTED;

  // Record the output (and transcript key, if uploaded). No-op if the run row
  // was pruned.
  await db
    .update(taskRun)
    .set({
      ...(key && { transcriptKey: key }),
      ...(pullRequestUrl && { pullRequestUrl }),
      ...(createdIssueUrl && { createdIssueUrl }),
      ...(tokens && {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadInputTokens: tokens.cacheReadInputTokens,
        cacheCreationInputTokens: tokens.cacheCreationInputTokens,
      }),
      harnessContract,
      updatedAt: new Date(),
    })
    .where(eq(taskRun.jobName, jobName));

  // Background push: this callback is the server-side "run finished" signal, so
  // alert the owner's subscribed browsers even if the app is closed. Best-effort
  // — sendPushToUser never throws, and it's a no-op when push isn't configured
  // or the user has no subscriptions. The harness may report the terminal state
  // via x-bandolier-status ("Succeeded"/"Failed"); absent it, a neutral title.
  if (run?.spawnedBy) {
    const failed = req.headers.get("x-bandolier-status") === "Failed";
    await sendPushToUser(run.spawnedBy, {
      title: failed ? "Agent failed" : "Agent finished",
      body: run.displayName ?? jobName,
      tag: `complete:${jobName}`,
      url: run.repoFullName ? `/repo/${run.repoFullName}` : "/",
    });
  }

  console.log("[bandolier:ingest] run output stored", {
    job: jobName,
    transcriptStored: key !== null,
    bytes: transcript.length,
  });
  return NextResponse.json({ ok: true });
}
