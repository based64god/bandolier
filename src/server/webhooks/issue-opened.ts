import {
  setApprovalCommentId,
  storePendingRun,
} from "~/server/agents/agent-approval";
import { createAgentJob, type JobSpec } from "~/server/agents/create-job";
import {
  getRegistryPullSecret,
  getRepoBotToken,
} from "~/server/agents/github-app";
import { githubGitIdentity } from "~/server/agents/github-token";
import { postIssueCommentReturningId } from "~/server/agents/github-issues";
import {
  getUserRepoPermission,
  isMaintainerOrHigher,
  runUsesRepoCredentials,
} from "~/server/agents/repo-permissions";
import { repoToNamespace } from "~/server/agents/namespace";
import { db } from "~/server/db";
import { env } from "~/env";
import {
  buildIssueSystemPrompt,
  buildIssueUserMessage,
  makeIssueBranch,
} from "~/lib/issue-prompt";

import { shouldTriggerOnEvent } from "~/server/agents/webhook-config";
import { postBotAck } from "./bot-ack";
import { wantsInteractive, wantsIssueOutput } from "./labels";
import { resolveWebhookRun } from "./resolve-run";
import { type IssuePayload, type WebhookRunConfig } from "./types";

export async function handleIssueOpened(
  payload: IssuePayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { issue, repository, sender } = payload;
  const agentImage = config?.agentImage ?? null;

  // Trigger gate: by default webhook events never spawn agents. The repo opts
  // in with a trigger phrase the issue text must contain, or with
  // trigger-on-all-events, which fires on everything and ignores the phrase.
  if (!shouldTriggerOnEvent(config, `${issue.title}\n${issue.body ?? ""}`)) {
    console.log("[bandolier:webhook] issue skipped — not triggered", {
      issue: issue.number,
      prefix: config?.prefix ?? null,
    });
    return;
  }

  const run = await resolveWebhookRun({
    sender,
    repoFullName: repository.full_name,
    labels: issue.labels,
    defaultModel: config?.defaultWebhookModel ?? null,
    defaultEffort: config?.defaultWebhookEffort ?? null,
    logCtx: { issue: issue.number },
  });
  if (!run) return;
  const { linked, model, specBase, resolved } = run;

  console.log("[bandolier:webhook] issue opened", {
    repo: repository.full_name,
    issue: issue.number,
    title: issue.title,
    sender: sender.login,
    model,
  });

  // An `output:issue` label switches this run to producing a sub-task issue
  // instead of a PR: no working branch, and the harness frames the read-only
  // analysis itself (so the instructional PR framing is omitted here).
  const issueOutput = wantsIssueOutput(issue.labels);
  const agentBranch = issueOutput
    ? undefined
    : makeIssueBranch(issue.number, issue.title);
  if (issueOutput) {
    console.log("[bandolier:webhook] issue output (sub-task) requested", {
      issue: issue.number,
    });
  }

  // An `interactive` label starts a long-lived interactive session seeded with
  // the issue, which the opener then drives from the dashboard, rather than a
  // one-shot run.
  const interactive = wantsInteractive(issue.labels);
  if (interactive) {
    console.log("[bandolier:webhook] interactive session requested", {
      issue: issue.number,
    });
  }

  // Attribute commits to the issue author via their GitHub no-reply address, so
  // GitHub links them to that account regardless of the sender's email privacy.
  const gitIdentity = githubGitIdentity(sender.id, sender.login);

  // A custom image on a private ghcr.io package needs pull credentials — use the
  // issue author's GitHub OAuth token (GHCR rejects App installation tokens).
  // Best-effort: a failure leaves the cluster to pull with its own node creds.
  const imagePullSecret = agentImage
    ? (getRegistryPullSecret(agentImage, linked.accessToken) ?? undefined)
    : undefined;

  const spec: JobSpec = {
    ...specBase,
    namespace: repoToNamespace(repository.full_name),
    // Build the prompt here (no operator context): the issue context is stored
    // as CLAUDE_TASK and shown in the dashboard; the instructional framing goes
    // in the system prompt.
    task: buildIssueUserMessage(
      { number: issue.number, title: issue.title, body: issue.body ?? "" },
      "",
    ),
    systemPrompt: issueOutput
      ? undefined
      : buildIssueSystemPrompt({ title: issue.title }, agentBranch!),
    agentBranch,
    interactive: interactive || undefined,
    outputType: issueOutput ? "issue" : undefined,
    displayName: `#${issue.number}: ${issue.title}`,
    repoUrl: repository.clone_url,
    branch: repository.default_branch,
    issueNumber: String(issue.number),
    issueUrl: issue.html_url,
    repoFullName: repository.full_name,
    createdBy: sender.login,
    gitName: gitIdentity.name,
    gitEmail: gitIdentity.email,
    // Owner = the Bandolier user linked to the GitHub account that triggered the
    // event, so the agent shows up in that user's cross-repo overview.
    userId: linked.userId,
    githubToken: linked.accessToken ?? undefined,
    agentImage: agentImage ?? undefined,
    imagePullSecret,
    repoSystemPrompt: config?.systemPrompt ?? undefined,
    networkPolicy: config?.networkPolicy,
  };

  // Privilege gate: when this run would spend the repo's *shared* credentials (a
  // repo-level kubeconfig or model key), only a GitHub user with maintainer-or-
  // higher on the repo may execute it. A less-privileged opener has the run held
  // for approval — the bot comments asking a maintainer to approve (by reacting
  // to or replying to that comment), and the run is dispatched only then.
  const usesRepoCreds = await runUsesRepoCredentials(
    db,
    linked.userId,
    repository.full_name,
    resolved,
  );
  if (usesRepoCreds) {
    const botToken = await getRepoBotToken(
      db,
      repository.full_name,
      Date.now(),
    );
    // Check the opener's privilege using the bot token (or, failing that, their
    // own). Without any token we can't verify, so we fail closed and hold.
    const permToken = botToken ?? linked.accessToken ?? null;
    const permission = permToken
      ? await getUserRepoPermission(
          permToken,
          repository.full_name,
          sender.login,
        )
      : "none";
    if (!isMaintainerOrHigher(permission)) {
      console.log(
        "[bandolier:webhook] issue held for approval — repo credentials + under-privileged opener",
        {
          issue: issue.number,
          sender: sender.login,
          permission,
        },
      );
      const pendingId = await storePendingRun(db, {
        repoFullName: repository.full_name,
        issueNumber: issue.number,
        requestedByLogin: sender.login,
        spec,
      });
      const commentBody =
        `🤖 This issue would run a Bandolier agent on **${repository.full_name}**'s ` +
        `shared repo-level credentials, which requires **maintainer** access or higher.\n\n` +
        `@${sender.login} doesn't have that on this repo, so the run is held for approval.\n\n` +
        `A maintainer can approve it by reacting 👍 to this comment, or replying \`/bando approve\`.`;
      if (botToken) {
        try {
          const commentId = await postIssueCommentReturningId(
            botToken,
            repository.full_name,
            issue.number,
            commentBody,
          );
          await setApprovalCommentId(db, pendingId, String(commentId));
          console.log("[bandolier:webhook] approval comment posted", {
            issue: issue.number,
            comment: commentId,
          });
        } catch (err) {
          console.warn("[bandolier:webhook] failed to post approval comment", {
            issue: issue.number,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        console.warn(
          "[bandolier:webhook] run held but no bot token to request approval",
          { issue: issue.number },
        );
      }
      return;
    }
    console.log(
      "[bandolier:webhook] repo credentials used — opener is maintainer+",
      { issue: issue.number, sender: sender.login, permission },
    );
  }

  const jobName = await createAgentJob(spec);

  // Notify the issue author that the task was received and is being worked on.
  const taskUrl = `${env.BETTER_AUTH_URL}/repo/${repository.full_name}`;
  const commentBody =
    `🤖 Bando picked up this issue and is working on it.\n\n` +
    `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`)`;
  const postedBy = await postBotAck(
    repository.full_name,
    issue.number,
    commentBody,
  );
  if (postedBy) {
    console.log("[bandolier:webhook] issue comment posted", {
      issue: issue.number,
      job: jobName,
      via: postedBy,
    });
  } else {
    console.warn(
      "[bandolier:webhook] failed to post issue comment — no usable token",
      { issue: issue.number },
    );
  }
}

/**
 * An issue edited to newly contain the configured trigger phrase starts a run,
 * exactly as if it had just been opened. Only the *transition* into containing
 * the prefix fires: an edit that leaves an already-triggering issue triggering
 * (e.g. tweaking wording after the fact) must not re-run it, and neither must an
 * edit that never involves the prefix. The pre-edit text is reconstructed from
 * the payload's `changes` (which carries only the fields that changed), so we
 * can tell whether the prefix was already there before this edit.
 *
 * Requires a configured trigger phrase: with no prefix nothing triggers on
 * edits, and with trigger-on-all-events `opened` already acted on every issue,
 * so there is no "newly triggered by an edit" state to detect in either case.
 */
export async function handleIssueEdited(
  payload: IssuePayload,
  config: WebhookRunConfig,
): Promise<void> {
  const { issue, changes } = payload;
  const prefix = config?.prefix ?? null;

  if (!prefix || config?.triggerOnAllEvents) return;

  const newText = `${issue.title}\n${issue.body ?? ""}`;
  if (!newText.includes(prefix)) return;

  // Reconstruct the text as it was before this edit: for each field that
  // changed, use its `from` value; for a field that didn't change, its current
  // value is unchanged and already reflects the pre-edit state.
  const oldTitle = changes?.title ? changes.title.from : issue.title;
  const oldBody = changes?.body
    ? (changes.body.from ?? "")
    : (issue.body ?? "");
  const oldText = `${oldTitle}\n${oldBody}`;
  if (oldText.includes(prefix)) {
    console.log(
      "[bandolier:webhook] issue edit skipped — prefix already present before edit",
      { issue: issue.number, prefix },
    );
    return;
  }

  console.log("[bandolier:webhook] issue edited to include trigger — running", {
    issue: issue.number,
    prefix,
  });
  await handleIssueOpened(payload, config);
}
