import { and, desc, eq } from "drizzle-orm";

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
} from "~/lib/issue-prompt";

import { postBotAck } from "./bot-ack";
import { resolveWebhookRun } from "./resolve-run";
import { type IssueCommentPayload, type WebhookRunConfig } from "./types";

/** The PR number at the end of a GitHub pull-request URL, or null. */
function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const m = /\/pull\/(\d+)$/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * A comment on an issue or pull request resumes the most recent run for that
 * item: a new agent run seeded with the parent run's persisted transcript
 * (fetched by the harness via BANDOLIER_CONTEXT_URL) and, when the parent's PR
 * is still open, working directly on its branch so follow-up commits land on
 * the same PR. Comments with no prior run are ignored — resuming is the only
 * thing a comment triggers — and repos without an artifact store are skipped
 * entirely, since no parent transcript was persisted to resume from.
 */
export async function handleIssueComment(
  payload: IssueCommentPayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { issue, comment, repository } = payload;
  const prefix = config?.prefix ?? null;
  const agentImage = config?.agentImage ?? null;
  const isPullRequest = !!issue.pull_request;
  const kind = isPullRequest ? ("pull request" as const) : ("issue" as const);
  const logCtx = { issue: issue.number, kind, comment: true };

  // Bot comments never trigger a resume — most importantly Bando's own
  // "picked up / resuming" acknowledgements, which would otherwise loop.
  if (comment.user.type === "Bot" || comment.user.login.endsWith("[bot]")) {
    return;
  }

  const commentBody = comment.body ?? "";

  // Prefix gate: if a trigger phrase is configured, the comment must contain
  // it; otherwise act on every comment (that has a run to resume).
  if (prefix && !commentBody.includes(prefix)) {
    console.log("[bandolier:webhook] comment skipped — prefix not present", {
      ...logCtx,
      prefix,
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
  // means there is nothing to resume.
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
            eq(taskRun.pullRequestUrl, issue.pull_request!.html_url),
          )
        : and(
            eq(taskRun.repoFullName, repository.full_name),
            eq(taskRun.issueNumber, String(issue.number)),
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
    sender: { id: comment.user.id, login: comment.user.login },
    repoFullName: repository.full_name,
    labels: issue.labels,
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
    ? issue.number
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
    resumeBranch ?? makeIssueBranch(issue.number, issue.title);

  console.log("[bandolier:webhook] comment resumes run", {
    repo: repository.full_name,
    ...logCtx,
    parent: parent.jobName,
    branch: agentBranch,
    continuesBranch: !!resumeBranch,
    sender: comment.user.login,
    model,
  });

  // Attribute commits to the commenter via their GitHub no-reply address, so
  // GitHub links them to that account regardless of email privacy.
  const gitIdentity = githubGitIdentity(comment.user.id, comment.user.login);

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
      number: issue.number,
      title: issue.title,
      commenter: comment.user.login,
      comment: commentBody,
    }),
    systemPrompt: buildResumeSystemPrompt(agentBranch, !!resumeBranch),
    agentBranch,
    displayName: `↻ #${issue.number}: ${issue.title}`,
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
    issueNumber: isPullRequest ? undefined : String(issue.number),
    issueUrl: isPullRequest ? undefined : issue.html_url,
    repoFullName: repository.full_name,
    createdBy: comment.user.login,
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
    issue.number,
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
