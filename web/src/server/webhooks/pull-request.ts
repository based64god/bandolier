import { and, desc, eq } from "drizzle-orm";

import { createAgentJob, type JobSpec } from "~/server/agents/create-job";
import { getRegistryPullSecret } from "~/server/agents/github-app";
import { repoToNamespace } from "~/server/agents/namespace";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import {
  buildReReviewUserMessage,
  buildReviewUserMessage,
} from "~/lib/review-prompt";

import { resolveWebhookRun } from "./resolve-run";
import { type PullRequestPayload, type WebhookRunConfig } from "./types";

/**
 * A pull request opened (or a draft marked ready for review) gets an automatic
 * Bandolier code review, when the repo has opted in (`reviewPullRequests`, gated
 * in the route). A read-only review run analyses the PR; its review is submitted
 * server-side in the bandolier[bot] voice — never the opener's credentials (see
 * the review-submit endpoint). The run is owned by the opener (their model
 * credentials), like an issue-triggered run; if they aren't a Bandolier user or
 * have no credentials, `resolveWebhookRun` skips it.
 */
export async function handlePullRequestOpened(
  payload: PullRequestPayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { pull_request: pr } = payload;
  const logCtx = { pr: pr.number, review: true };

  // A draft PR isn't ready for review yet — wait for `ready_for_review`. GitHub
  // delivers `opened` for a PR created as a draft with draft=true.
  if (pr.draft) {
    console.log("[bandolier:webhook] review skipped — draft PR", logCtx);
    return;
  }

  await launchReview({ payload, config, logCtx });
}

/**
 * A push to a reviewed PR's branch (`pull_request` synchronize) re-reviews it by
 * resuming the PR's most recent review run — seeded with that run's persisted
 * transcript so the re-review builds on the earlier one rather than starting
 * cold. Requires the repo's artifact store (no store ⇒ no transcript to resume
 * from) and a prior review to resume; with neither the push is ignored. Comments
 * on the review resume the *coding* run instead (see resumeFromComment).
 */
export async function handlePullRequestSynchronize(
  payload: PullRequestPayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { pull_request: pr, repository } = payload;
  const logCtx = { pr: pr.number, review: true, resume: true };

  // Resuming seeds the re-review with the prior review's persisted transcript,
  // which only exists when the repo has an artifact store. Without one there is
  // nothing to resume, so skip (the initial review already ran without a store,
  // but a re-review that carried no prior context would be misleading).
  if (!config?.hasArtifactStore) {
    console.log(
      "[bandolier:webhook] re-review skipped — no artifact store configured",
      logCtx,
    );
    return;
  }

  // The parent is the PR's most recent review run, matched by the PR it reviews
  // (reviewed_pr_url). No prior review ⇒ nothing to re-review (the PR was never
  // reviewed — e.g. review was enabled after it opened, or the opener wasn't a
  // Bandolier user).
  const [parent] = await db
    .select({ jobName: taskRun.jobName, displayName: taskRun.displayName })
    .from(taskRun)
    .where(
      and(
        eq(taskRun.repoFullName, repository.full_name),
        eq(taskRun.reviewedPrUrl, pr.html_url),
      ),
    )
    .orderBy(desc(taskRun.createdAt))
    .limit(1);
  if (!parent) {
    console.log(
      "[bandolier:webhook] re-review skipped — no prior review to resume",
      logCtx,
    );
    return;
  }

  await launchReview({
    payload,
    config,
    logCtx,
    resume: { parentJobName: parent.jobName, parentDisplayName: parent.displayName },
  });
}

/**
 * Shared review launcher for both the initial review and a re-review resume.
 * Resolves the run's model/credentials from the acting GitHub user (the PR
 * opener, or the pusher for a re-review), builds a review JobSpec — read-only,
 * no working branch — and creates the job. A re-review additionally threads the
 * parent review run's lineage so the harness seeds it with that transcript.
 */
async function launchReview(opts: {
  payload: PullRequestPayload;
  config: WebhookRunConfig;
  logCtx: Record<string, unknown>;
  resume?: { parentJobName: string; parentDisplayName: string };
}): Promise<void> {
  const { payload, config, logCtx, resume } = opts;
  const { pull_request: pr, repository, sender } = payload;
  const agentImage = config?.agentImage ?? null;

  const run = await resolveWebhookRun({
    sender,
    repoFullName: repository.full_name,
    labels: pr.labels,
    // Prefer the repo's review-specific model; fall back to the webhook model.
    defaultModel: config?.reviewModel ?? config?.defaultWebhookModel ?? null,
    defaultEffort: config?.defaultWebhookEffort ?? null,
    logCtx,
  });
  if (!run) return;
  const { linked, model, specBase } = run;

  console.log("[bandolier:webhook] reviewing pull request", {
    repo: repository.full_name,
    ...logCtx,
    title: pr.title,
    sender: sender.login,
    model,
    resumes: resume?.parentJobName ?? null,
  });

  // A custom image on a private ghcr.io package needs pull credentials — use the
  // acting user's GitHub OAuth token (GHCR rejects App installation tokens).
  const imagePullSecret = agentImage
    ? (getRegistryPullSecret(agentImage, linked.accessToken) ?? undefined)
    : undefined;

  const spec: JobSpec = {
    ...specBase,
    namespace: repoToNamespace(repository.full_name),
    // The PR context is the task; the harness frames the read-only review
    // objective itself (no server-supplied system prompt) and fetches the diff.
    task: resume
      ? buildReReviewUserMessage({ number: pr.number, title: pr.title })
      : buildReviewUserMessage({
          number: pr.number,
          title: pr.title,
          body: pr.body ?? "",
        }),
    outputType: "review",
    reviewPrNumber: String(pr.number),
    reviewedPrUrl: pr.html_url,
    displayName: resume
      ? `Re-review #${pr.number}: ${pr.title}`
      : `Review #${pr.number}: ${pr.title}`,
    repoUrl: repository.clone_url,
    // The harness clones the base branch and checks out the PR head to review it.
    branch: repository.default_branch,
    repoFullName: repository.full_name,
    createdBy: sender.login,
    // The review is posted in the bot voice, and a review makes no commits, so no
    // git identity is attributed to the acting user.
    userId: linked.userId,
    githubToken: linked.accessToken ?? undefined,
    agentImage: agentImage ?? undefined,
    imagePullSecret,
    repoSystemPrompt: config?.systemPrompt ?? undefined,
    networkPolicy: config?.networkPolicy,
    ...(resume && {
      parentJobName: resume.parentJobName,
      parentDisplayName: resume.parentDisplayName,
    }),
  };

  const jobName = await createAgentJob(spec);
  console.log("[bandolier:webhook] review run created", {
    ...logCtx,
    job: jobName,
    resumes: resume?.parentJobName ?? null,
  });
}
