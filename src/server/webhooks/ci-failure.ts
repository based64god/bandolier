import { and, desc, eq } from "drizzle-orm";

import { createAgentJob } from "~/server/agents/create-job";
import { getRegistryPullSecret } from "~/server/agents/github-app";
import {
  getGithubAccountByUserId,
  githubGitIdentity,
} from "~/server/agents/github-token";
import { getPullRequestRefs } from "~/server/agents/github-issues";
import { repoToNamespace } from "~/server/agents/namespace";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import { env } from "~/env";
import {
  buildCiResumeUserMessage,
  buildResumeSystemPrompt,
} from "~/lib/issue-prompt";

import { postBotAck } from "./bot-ack";
import { resolveWebhookRun } from "./resolve-run";
import { type WebhookRunConfig, type WorkflowRunPayload } from "./types";

// Maximum number of times a single pull request is auto-resumed by CI failures
// before Bandolier gives up, so a run whose fix never makes CI pass can't loop
// resume→push→fail→resume forever. Counted along the resumed-run lineage.
const MAX_CI_RESUMES = 3;

/**
 * Counts how many runs in a resume lineage were themselves triggered by a CI
 * failure (they carry a `ciResumeSha`), walking `parentJobName` from `jobName`
 * back toward the root run. Used to cap auto-resumes per pull request. The walk
 * is bounded so a corrupt parent cycle can't spin.
 */
async function countCiResumesInLineage(jobName: string): Promise<number> {
  let count = 0;
  let cursor: string | null = jobName;
  for (let i = 0; cursor && i < MAX_CI_RESUMES + 5; i++) {
    const [row]: {
      parentJobName: string | null;
      ciResumeSha: string | null;
    }[] = await db
      .select({
        parentJobName: taskRun.parentJobName,
        ciResumeSha: taskRun.ciResumeSha,
      })
      .from(taskRun)
      .where(eq(taskRun.jobName, cursor))
      .limit(1);
    if (!row) break;
    if (row.ciResumeSha) count++;
    cursor = row.parentJobName;
  }
  return count;
}

/**
 * A failing CI pipeline (a `workflow_run` completed with conclusion "failure")
 * auto-resumes the Bandolier run that produced the pull request it ran on, when
 * the repo has opted in via `resumeOnCiFailure`. The resumed run is seeded with
 * the parent's transcript and continues on the PR's own branch — the same
 * machinery a human follow-up comment uses — but is framed to investigate the
 * pipeline failure and push a fix. There is no human sender, so the run is owned
 * by (and spends the credentials of) the parent run's owner.
 *
 * Gated and bounded so it can't run away:
 *   - only same-repo, still-open PRs with a prior Bandolier run are resumed
 *     (a fork's branch can't be pushed to);
 *   - each failing commit resumes at most once (deduped by head SHA), so
 *     redelivered events and several pipelines failing on the same commit don't
 *     each spawn a run;
 *   - a PR stops auto-resuming after MAX_CI_RESUMES, so a fix that never lands
 *     doesn't loop.
 */
export async function handleCiFailure(
  payload: WorkflowRunPayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { workflow_run: wr, repository } = payload;
  const agentImage = config?.agentImage ?? null;

  // Only a completed, failed pipeline is actionable (success/cancelled/etc. are
  // not "CI failed"). The caller already filters action === "completed".
  if (wr.conclusion !== "failure") return;

  const headSha = wr.head_sha;
  const prs = wr.pull_requests ?? [];
  if (prs.length === 0) {
    console.log(
      "[bandolier:webhook] ci failure has no associated PR — skipped",
      { repo: repository.full_name, workflow: wr.name, branch: wr.head_branch },
    );
    return;
  }

  for (const pr of prs) {
    const logCtx = {
      repo: repository.full_name,
      pr: pr.number,
      workflow: wr.name,
      ci: true,
    };
    const prUrl = `https://github.com/${repository.full_name}/pull/${pr.number}`;

    // The parent is the most recent run whose output is this PR. No run means
    // the PR wasn't produced by Bandolier — there is nothing to resume.
    const [parent] = await db
      .select({
        jobName: taskRun.jobName,
        displayName: taskRun.displayName,
        spawnedBy: taskRun.spawnedBy,
        createdBy: taskRun.createdBy,
      })
      .from(taskRun)
      .where(
        and(
          eq(taskRun.repoFullName, repository.full_name),
          eq(taskRun.pullRequestUrl, prUrl),
        ),
      )
      .orderBy(desc(taskRun.createdAt))
      .limit(1);
    if (!parent) {
      console.log("[bandolier:webhook] ci failure — no run to resume", logCtx);
      continue;
    }

    // De-dupe on the failing commit: a workflow_run can be redelivered, and a
    // PR can run several pipelines that all fail on the same commit. Resume
    // once per failing commit only.
    const [already] = await db
      .select({ jobName: taskRun.jobName })
      .from(taskRun)
      .where(
        and(
          eq(taskRun.repoFullName, repository.full_name),
          eq(taskRun.ciResumeSha, headSha),
        ),
      )
      .limit(1);
    if (already) {
      console.log(
        "[bandolier:webhook] ci failure already resumed for this commit — skipped",
        { ...logCtx, sha: headSha, job: already.jobName },
      );
      continue;
    }

    // Cap: stop auto-resuming a PR whose fixes never make CI pass. Log only —
    // skipped failures record no de-dupe marker, so commenting here would repost
    // on every later failing commit / CI re-run and spam the PR. A human can
    // still resume manually by commenting.
    const priorResumes = await countCiResumesInLineage(parent.jobName);
    if (priorResumes >= MAX_CI_RESUMES) {
      console.log(
        "[bandolier:webhook] ci failure — auto-resume cap reached, skipped",
        { ...logCtx, priorResumes, cap: MAX_CI_RESUMES },
      );
      continue;
    }

    // No human triggered this — resume as the parent run's owner, spending their
    // credentials. Requires their linked GitHub account (id → the shared run
    // resolver, which is keyed off the GitHub account id).
    if (!parent.spawnedBy) {
      console.log(
        "[bandolier:webhook] ci failure — parent run has no owner to resume as",
        logCtx,
      );
      continue;
    }
    const ownerAccount = await getGithubAccountByUserId(db, parent.spawnedBy);
    if (!ownerAccount) {
      console.log(
        "[bandolier:webhook] ci failure — parent run owner has no linked GitHub account",
        logCtx,
      );
      continue;
    }
    // The owner's login, when the parent recorded one — used for display and,
    // when present, the git identity. Null for pre-`createdBy` runs.
    const ownerLogin = parent.createdBy;
    const displayLogin = ownerLogin ?? "the task owner";

    // No issue labels drive a CI resume; model/effort/compute come from the
    // repo defaults (and the owner's credentials), same as any webhook run.
    const run = await resolveWebhookRun({
      sender: { id: Number(ownerAccount.githubId), login: displayLogin },
      repoFullName: repository.full_name,
      labels: [],
      defaultModel: config?.defaultWebhookModel ?? null,
      defaultEffort: config?.defaultWebhookEffort ?? null,
      logCtx,
    });
    if (!run) continue;
    const { linked, model, specBase } = run;

    // The fix has to land on the PR's own branch, so the PR must still be open
    // and same-repo (a fork's branch can't be pushed to).
    if (!linked.accessToken) {
      console.log(
        "[bandolier:webhook] ci failure — owner has no GitHub token",
        logCtx,
      );
      continue;
    }
    const refs = await getPullRequestRefs(
      linked.accessToken,
      repository.full_name,
      pr.number,
    );
    if (!refs) {
      console.log(
        "[bandolier:webhook] ci failure — could not read PR refs",
        logCtx,
      );
      continue;
    }
    if (
      refs.state !== "open" ||
      refs.headRepoFullName !== repository.full_name
    ) {
      console.log("[bandolier:webhook] ci failure — PR not continuable", {
        ...logCtx,
        state: refs.state,
        merged: refs.merged,
      });
      continue;
    }
    const resumeBranch = refs.headRef;
    const baseBranch = refs.baseRef;

    console.log("[bandolier:webhook] ci failure resumes run", {
      ...logCtx,
      parent: parent.jobName,
      branch: resumeBranch,
      sha: headSha,
      model,
    });

    // Attribute the fix commits to the run's owner, like a comment resume does.
    // Without a recorded login, fall back to the account's login-less no-reply
    // address (still valid and linked to the account) so the email is well-formed.
    const gitIdentity = ownerLogin
      ? githubGitIdentity(Number(ownerAccount.githubId), ownerLogin)
      : {
          name: "Bandolier Agent",
          email: `${ownerAccount.githubId}@users.noreply.github.com`,
        };
    const imagePullSecret = agentImage
      ? (getRegistryPullSecret(agentImage, linked.accessToken) ?? undefined)
      : undefined;

    const jobName = await createAgentJob({
      ...specBase,
      namespace: repoToNamespace(repository.full_name),
      task: buildCiResumeUserMessage({
        prNumber: pr.number,
        title: refs.title,
        workflowName: wr.name,
        runUrl: wr.html_url,
      }),
      systemPrompt: buildResumeSystemPrompt(resumeBranch, true),
      agentBranch: resumeBranch,
      displayName: `⚙ CI #${pr.number}: ${refs.title}`,
      repoUrl: repository.clone_url,
      branch: resumeBranch,
      baseBranch,
      resumeBranch,
      parentJobName: parent.jobName,
      parentDisplayName: parent.displayName,
      // Records the failing commit so a redelivery / another pipeline failing on
      // the same commit is de-duped, and this run counts toward the PR's cap.
      ciResumeSha: headSha,
      repoFullName: repository.full_name,
      createdBy: ownerLogin ?? undefined,
      gitName: gitIdentity.name,
      gitEmail: gitIdentity.email,
      userId: linked.userId,
      githubToken: linked.accessToken ?? undefined,
      agentImage: agentImage ?? undefined,
      imagePullSecret,
      repoSystemPrompt: config?.systemPrompt ?? undefined,
      networkPolicy: config?.networkPolicy,
    });

    // Acknowledge on the PR, bot-voice only.
    const taskUrl = `${env.BETTER_AUTH_URL}/repo/${repository.full_name}`;
    const ackBody =
      `🤖 CI (\`${wr.name}\`) failed — Bando is resuming to fix it.\n\n` +
      `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`, resumes \`${parent.jobName}\`)`;
    const postedBy = await postBotAck(repository.full_name, pr.number, ackBody);
    console.log("[bandolier:webhook] ci failure resume dispatched", {
      ...logCtx,
      job: jobName,
      via: postedBy ?? "none",
    });
  }
}
