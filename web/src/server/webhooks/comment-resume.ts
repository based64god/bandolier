import { and, desc, eq, isNull } from "drizzle-orm";

import { createAgentJob } from "~/server/agents/create-job";
import { getRegistryPullSecret } from "~/server/agents/github-app";
import { githubGitIdentity } from "~/server/agents/github-token";
import { getPullRequestRefs } from "~/server/agents/github-issues";
import { repoToNamespace } from "~/server/agents/namespace";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import { env } from "~/env";
import {
  buildResumeSystemPrompt,
  buildResumeUserMessage,
  makeIssueBranch,
  type ReviewCommentLocation,
} from "~/lib/issue-prompt";

import { shouldTriggerOnEvent } from "~/server/agents/webhook-config";
import { postBotAck } from "./bot-ack";
import { resolveWebhookRun } from "./resolve-run";
import { type GitHubRepository, type WebhookRunConfig } from "./types";

/** The PR number at the end of a GitHub pull-request URL, or null. */
function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const m = /\/pull\/(\d+)$/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * A normalized comment-resume request, built by each webhook handler from its
 * event payload. An `issue_comment` fills it from the issue (or, when the issue
 * is a PR, the pull request); a `pull_request_review_comment` fills it from the
 * pull request and adds `reviewComment` line metadata. Everything downstream of
 * this shape is identical for both, so the handlers just normalize and delegate.
 */
export interface CommentResume {
  /** "issue" for an issue comment, "pull request" for any PR comment. */
  kind: "issue" | "pull request";
  isPullRequest: boolean;
  /** The commented item's number (issue number or PR number). */
  number: number;
  title: string;
  /** The item's labels, considered for model/effort/compute selection. */
  labels: { name: string }[];
  /** The item's html url — set as the run's issueUrl for true issues only. */
  htmlUrl: string;
  /** The PR's html_url when commenting on a PR; null for an issue. */
  pullRequestUrl: string | null;
  repository: GitHubRepository;
  /** The commenting user. */
  user: { id: number; login: string; type?: string };
  /** The raw comment body. */
  body: string;
  /**
   * The file/line a PR review comment is anchored to. Absent for vanilla
   * comments; folded into the resume user message when present.
   */
  reviewComment?: ReviewCommentLocation;
}

/**
 * A comment on an issue or pull request resumes the most recent run for that
 * item: a new agent run seeded with the parent run's persisted transcript
 * (fetched by the harness via BANDOLIER_CONTEXT_URL) and, when the parent's PR
 * is still open, working directly on its branch so follow-up commits land on
 * the same PR. Comments with no prior run are ignored — resuming is the only
 * thing a comment triggers — and repos without an artifact store are skipped
 * entirely, since no parent transcript was persisted to resume from.
 *
 * Shared by every comment event: vanilla issue/PR comments (`issue_comment`) and
 * inline PR review comments (`pull_request_review_comment`). The caller
 * normalizes its payload into `CommentResume` first.
 */
export async function resumeFromComment(
  input: CommentResume,
  config: WebhookRunConfig,
): Promise<void> {
  const { repository, user, kind, isPullRequest } = input;
  const agentImage = config?.agentImage ?? null;
  const logCtx = { issue: input.number, kind, comment: true };

  // Bot comments never trigger a resume — most importantly Bando's own
  // "picked up / resuming" acknowledgements, which would otherwise loop.
  if (user.type === "Bot" || user.login.endsWith("[bot]")) {
    return;
  }

  const commentBody = input.body ?? "";

  // Trigger gate: by default webhook events never spawn agents. The repo opts
  // in with a trigger phrase the comment must contain, or with
  // trigger-on-all-events, which fires on every comment (that has a run to
  // resume) and ignores the phrase.
  if (!shouldTriggerOnEvent(config, commentBody)) {
    console.log("[bandolier:webhook] comment skipped — not triggered", {
      ...logCtx,
      prefix: config?.prefix ?? null,
    });
    return;
  }

  // Artifact-store gate: resuming seeds the new run with the parent's
  // persisted transcript, and transcripts are only persisted when the repo has
  // configured its artifact store (bucket + keys). Without one the "resumed"
  // run would carry none of the parent's context, so don't spawn it at all.
  if (!config?.hasArtifactStore) {
    console.log(
      "[bandolier:webhook] comment skipped — no artifact store configured",
      logCtx,
    );
    return;
  }

  // The parent is the most recent run for the commented item: matched by PR
  // URL for pull requests, by repo + issue number for issues. No parent run
  // means there is nothing to resume. Review runs are excluded (reviewed_pr_url
  // is null on coding runs): a comment on a PR — including a reply to one of the
  // bot's review comments — resumes the run that *opened* the PR, not the review
  // of it; a push to the branch re-reviews (see handlePullRequestSynchronize).
  const [parent] = await db
    .select({
      jobName: taskRun.jobName,
      displayName: taskRun.displayName,
      pullRequestUrl: taskRun.pullRequestUrl,
    })
    .from(taskRun)
    .where(
      isPullRequest
        ? and(
            eq(taskRun.repoFullName, repository.full_name),
            eq(taskRun.pullRequestUrl, input.pullRequestUrl!),
            isNull(taskRun.reviewedPrUrl),
          )
        : and(
            eq(taskRun.repoFullName, repository.full_name),
            eq(taskRun.issueNumber, String(input.number)),
            isNull(taskRun.reviewedPrUrl),
          ),
    )
    .orderBy(desc(taskRun.createdAt))
    .limit(1);
  if (!parent) {
    console.log(
      "[bandolier:webhook] comment skipped — no run to resume",
      logCtx,
    );
    return;
  }

  const run = await resolveWebhookRun({
    sender: { id: user.id, login: user.login },
    repoFullName: repository.full_name,
    labels: input.labels,
    defaultModel: config?.defaultWebhookModel ?? null,
    defaultEffort: config?.defaultWebhookEffort ?? null,
    logCtx,
  });
  if (!run) return;
  const { linked, model, specBase } = run;

  // Continue on the parent's PR branch when there is one and it's still open
  // and same-repo (a fork's branch can't be pushed to). The PR is either the
  // one being commented on, or the one the parent run opened for the issue.
  // Otherwise the resume starts a fresh branch — still carrying the parent's
  // context — and produces a new PR.
  let resumeBranch: string | undefined;
  let baseBranch = repository.default_branch;
  const prNumber = isPullRequest
    ? input.number
    : prNumberFromUrl(parent.pullRequestUrl);
  if (prNumber !== null && linked.accessToken) {
    const refs = await getPullRequestRefs(
      linked.accessToken,
      repository.full_name,
      prNumber,
    );
    if (
      refs?.state === "open" &&
      refs.headRepoFullName === repository.full_name
    ) {
      resumeBranch = refs.headRef;
      baseBranch = refs.baseRef;
    } else if (refs) {
      console.log(
        "[bandolier:webhook] resuming on a fresh branch — PR branch not continuable",
        { ...logCtx, pr: prNumber, state: refs.state, merged: refs.merged },
      );
    }
  }
  const agentBranch =
    resumeBranch ?? makeIssueBranch(input.number, input.title);

  console.log("[bandolier:webhook] comment resumes run", {
    repo: repository.full_name,
    ...logCtx,
    parent: parent.jobName,
    branch: agentBranch,
    continuesBranch: !!resumeBranch,
    sender: user.login,
    model,
  });

  // Attribute commits to the commenter via their GitHub no-reply address, so
  // GitHub links them to that account regardless of email privacy.
  const gitIdentity = githubGitIdentity(user.id, user.login);

  // A custom image on a private ghcr.io package needs pull credentials — use
  // the commenter's GitHub OAuth token (GHCR rejects App installation tokens).
  const imagePullSecret = agentImage
    ? (getRegistryPullSecret(agentImage, linked.accessToken) ?? undefined)
    : undefined;

  const jobName = await createAgentJob({
    ...specBase,
    namespace: repoToNamespace(repository.full_name),
    task: buildResumeUserMessage({
      kind,
      number: input.number,
      title: input.title,
      commenter: user.login,
      comment: commentBody,
      reviewComment: input.reviewComment,
    }),
    systemPrompt: buildResumeSystemPrompt(agentBranch, !!resumeBranch),
    agentBranch,
    displayName: `↻ #${input.number}: ${input.title}`,
    repoUrl: repository.clone_url,
    // Resumes clone the branch they continue; fresh-branch resumes start from
    // the default branch like any issue run.
    branch: resumeBranch ?? repository.default_branch,
    baseBranch,
    resumeBranch,
    parentJobName: parent.jobName,
    parentDisplayName: parent.displayName,
    // Only true issues enter the harness's issue mode — a PR number isn't
    // viewable through `gh issue view`, and the PR link comes from the run's
    // own output anyway.
    issueNumber: isPullRequest ? undefined : String(input.number),
    issueUrl: isPullRequest ? undefined : input.htmlUrl,
    repoFullName: repository.full_name,
    createdBy: user.login,
    gitName: gitIdentity.name,
    gitEmail: gitIdentity.email,
    userId: linked.userId,
    githubToken: linked.accessToken ?? undefined,
    agentImage: agentImage ?? undefined,
    imagePullSecret,
    repoSystemPrompt: config?.systemPrompt ?? undefined,
    networkPolicy: config?.networkPolicy,
  });

  // Acknowledge in the thread, bot-voice only.
  const taskUrl = `${env.BETTER_AUTH_URL}/repo/${repository.full_name}`;
  const ackBody =
    `🤖 Bando is resuming work on this ${kind}.\n\n` +
    `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`, resumes \`${parent.jobName}\`)`;
  const postedBy = await postBotAck(
    repository.full_name,
    input.number,
    ackBody,
  );
  if (postedBy) {
    console.log("[bandolier:webhook] resume comment posted", {
      ...logCtx,
      job: jobName,
      via: postedBy,
    });
  } else {
    console.warn(
      "[bandolier:webhook] failed to post resume comment — no usable token",
      logCtx,
    );
  }
}
