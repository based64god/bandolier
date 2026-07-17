import crypto from "crypto";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { getRepoWebhookConfig } from "~/server/agents/webhook-config";
import { db } from "~/server/db";
import { handleApprovalComment } from "~/server/webhooks/approval";
import { handleCiFailure } from "~/server/webhooks/ci-failure";
import { handleInstallation } from "~/server/webhooks/installation";
import { handleIssueComment } from "~/server/webhooks/issue-comment";
import {
  handleIssueEdited,
  handleIssueOpened,
} from "~/server/webhooks/issue-opened";
import { handlePrReviewComment } from "~/server/webhooks/pr-review-comment";
import {
  handlePullRequestOpened,
  handlePullRequestSynchronize,
} from "~/server/webhooks/pull-request";
import {
  type InstallationPayload,
  type IssueCommentPayload,
  type IssuePayload,
  type PullRequestPayload,
  type PullRequestReviewCommentPayload,
  type WorkflowRunPayload,
} from "~/server/webhooks/types";

// ── Webhook signature verification ────────────────────────────────────────────

function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const event = req.headers.get("x-github-event");

  // This endpoint is public (auth is the HMAC signature check below), so a
  // malformed body must yield a clean 400 rather than an unhandled 500.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // The GitHub App delivers every repo's events to this one endpoint signed with
  // a single app-level secret, so verification uses GITHUB_WEBHOOK_SECRET for
  // all events. The signature check below is what authenticates the payload.
  const repoFullName: string | undefined = (payload as IssuePayload)?.repository
    ?.full_name;
  const secret = env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.warn("[bandolier:webhook] no webhook secret configured", {
      repo: repoFullName,
    });
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 503 },
    );
  }

  if (
    !verifySignature(rawBody, req.headers.get("x-hub-signature-256"), secret)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    if (event === "issues" && (payload as IssuePayload).action === "opened") {
      const config = repoFullName
        ? await getRepoWebhookConfig(db, repoFullName)
        : null;
      await handleIssueOpened(payload as IssuePayload, config);
    } else if (
      event === "issues" &&
      (payload as IssuePayload).action === "edited"
    ) {
      // An edit that newly introduces the repo's trigger phrase runs the issue
      // just like an open would; edits that don't cross that threshold are no-ops.
      const config = repoFullName
        ? await getRepoWebhookConfig(db, repoFullName)
        : null;
      await handleIssueEdited(payload as IssuePayload, config);
    } else if (
      event === "issue_comment" &&
      (payload as IssueCommentPayload).action === "created"
    ) {
      // A held, credential-gated run claims the item's comments first: they
      // approve/decline it rather than resuming anything. Otherwise a comment
      // on an issue or PR resumes that item's most recent run.
      const p = payload as IssueCommentPayload;
      const gated = await handleApprovalComment({
        action: p.action,
        repoFullName: p.repository.full_name,
        itemNumber: p.issue.number,
        commentBody: p.comment.body,
        sender: p.sender,
      });
      if (!gated) {
        const config = repoFullName
          ? await getRepoWebhookConfig(db, repoFullName)
          : null;
        await handleIssueComment(p, config);
      }
    } else if (
      event === "pull_request_review_comment" &&
      (payload as PullRequestReviewCommentPayload).action === "created"
    ) {
      // An inline review comment on a PR's diff resumes that PR's most recent
      // run, just like a vanilla comment, carrying the file/line it's anchored
      // to — and follows the same approval short-circuit: a held, credential-
      // gated run on that item consumes the comment as an approve/decline.
      const p = payload as PullRequestReviewCommentPayload;
      const gated = await handleApprovalComment({
        action: p.action,
        repoFullName: p.repository.full_name,
        itemNumber: p.pull_request.number,
        commentBody: p.comment.body,
        sender: p.sender,
      });
      if (!gated) {
        const config = repoFullName
          ? await getRepoWebhookConfig(db, repoFullName)
          : null;
        await handlePrReviewComment(p, config);
      }
    } else if (event === "pull_request") {
      // A pull request opened / marked ready for review gets an automatic
      // bot-voice review; a push to its branch (synchronize) re-reviews it. Both
      // are gated on the repo's opt-in, so the config read and handler work only
      // happen for repos that turned reviews on.
      const p = payload as PullRequestPayload;
      const config = repoFullName
        ? await getRepoWebhookConfig(db, repoFullName)
        : null;
      if (config?.reviewPullRequests) {
        if (p.action === "opened" || p.action === "ready_for_review") {
          await handlePullRequestOpened(p, config);
        } else if (p.action === "synchronize") {
          await handlePullRequestSynchronize(p, config);
        }
      }
    } else if (
      event === "workflow_run" &&
      (payload as WorkflowRunPayload).action === "completed"
    ) {
      // A CI pipeline finished. When the repo has opted into resumeable tasks,
      // a failing pipeline auto-resumes the run that produced the PR it ran on.
      // Gated here so the (extra) config read and DB work only happen for
      // opted-in repos; handleCiFailure further filters to failures.
      const config = repoFullName
        ? await getRepoWebhookConfig(db, repoFullName)
        : null;
      if (config?.resumeOnCiFailure) {
        await handleCiFailure(payload as WorkflowRunPayload, config);
      }
    } else if (event === "installation") {
      // App installed/uninstalled, or repos added/removed for an installation.
      const p = payload as InstallationPayload;
      await handleInstallation(p, p.action === "deleted");
    } else if (event === "installation_repositories") {
      // Repos added to / removed from an existing installation.
      await handleInstallation(payload as InstallationPayload, false);
    }
    // Other event types ignored for now.
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bandolier:webhook] handler error", {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
