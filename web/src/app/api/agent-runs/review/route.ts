import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { verifyIngestToken } from "~/lib/ingest";
import { getRepoBotToken } from "~/server/agents/github-app";
import {
  type ReviewComment,
  type ReviewEvent,
  submitPullRequestReview,
} from "~/server/agents/github-reviews";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";

/**
 * Authenticates a harness callback by its per-job HMAC token (the same token
 * the ingest callback uses), returning the job name or null.
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

const REVIEW_EVENTS = new Set<ReviewEvent>([
  "COMMENT",
  "APPROVE",
  "REQUEST_CHANGES",
]);

/** The PR number in a GitHub pull-request URL (which may carry an anchor). */
function prNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)(?:[#/?]|$)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** Keeps only well-formed inline comments (path + numeric line + body). */
function parseComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewComment[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (
      typeof o.path !== "string" ||
      typeof o.line !== "number" ||
      typeof o.body !== "string" ||
      !o.body.trim()
    ) {
      continue;
    }
    out.push({
      path: o.path,
      line: o.line,
      body: o.body,
      ...(typeof o.side === "string" ? { side: o.side } : {}),
      ...(typeof o.startLine === "number" ? { startLine: o.startLine } : {}),
      ...(typeof o.startSide === "string" ? { startSide: o.startSide } : {}),
    });
  }
  return out;
}

/**
 * Harness callback: submits a run's PR review. The harness produces the review
 * content read-only and POSTs it here; the server posts it to the pull request
 * using the GitHub App installation token, so the review is always attributed
 * to bandolier[bot] and NEVER to the acting user's credentials. Authenticated
 * by the run's per-job HMAC token (the same as the ingest callback), and scoped
 * to the PR recorded on the run row — the harness can't post to an arbitrary PR.
 */
export async function POST(req: NextRequest) {
  const jobName = authenticatedJob(req);
  if (!jobName) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const p = (payload ?? {}) as Record<string, unknown>;

  const event: ReviewEvent = REVIEW_EVENTS.has(p.event as ReviewEvent)
    ? (p.event as ReviewEvent)
    : "COMMENT";
  const body = typeof p.body === "string" ? p.body.trim() : "";
  const comments = parseComments(p.comments);
  // The GitHub reviews API rejects a review with neither a body nor comments.
  if (!body && comments.length === 0) {
    return NextResponse.json({ error: "Empty review" }, { status: 400 });
  }

  // The run row scopes the review to its PR (reviewed_pr_url), so a job can only
  // ever post to the PR it was created to review.
  const [run] = await db
    .select({
      repoFullName: taskRun.repoFullName,
      reviewedPrUrl: taskRun.reviewedPrUrl,
    })
    .from(taskRun)
    .where(eq(taskRun.jobName, jobName))
    .limit(1);
  const prNumber = run?.reviewedPrUrl ? prNumberFromUrl(run.reviewedPrUrl) : null;
  if (!run?.repoFullName || prNumber === null) {
    return NextResponse.json({ error: "Not a review run" }, { status: 404 });
  }

  // Bot voice only: the review is posted with the GitHub App installation token,
  // never a user credential. No App installation ⇒ no bot identity to review as,
  // so the review is skipped rather than posted under another credential.
  const botToken = await getRepoBotToken(db, run.repoFullName, Date.now());
  if (!botToken) {
    console.warn("[bandolier:review] no bot token — cannot post review", {
      job: jobName,
      repo: run.repoFullName,
      pr: prNumber,
    });
    return NextResponse.json(
      { error: "No bot identity for this repo" },
      { status: 503 },
    );
  }

  try {
    const reviewUrl = await submitPullRequestReview(
      botToken,
      run.repoFullName,
      prNumber,
      { event, body: body || "Reviewed by Bandolier.", comments },
    );
    // Record the review as the run's output so the dashboard can surface it,
    // surviving pod-log loss like the PR/issue URLs the ingest callback stores.
    await db
      .update(taskRun)
      .set({ pullRequestUrl: reviewUrl, updatedAt: new Date() })
      .where(eq(taskRun.jobName, jobName));
    console.log("[bandolier:review] review posted", {
      job: jobName,
      repo: run.repoFullName,
      pr: prNumber,
      event,
      comments: comments.length,
    });
    return NextResponse.json({ url: reviewUrl });
  } catch (err) {
    console.error("[bandolier:review] failed to post review", {
      job: jobName,
      repo: run.repoFullName,
      pr: prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to post review" }, { status: 502 });
  }
}
