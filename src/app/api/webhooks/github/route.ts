import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import {
  dispatchPendingRun,
  getUnresolvedPendingRun,
  markResolved,
  setApprovalCommentId,
  storePendingRun,
} from "~/server/agents/agent-approval";
import { validateAwsCredentials } from "~/server/agents/aws";
import { createAgentJob, type JobSpec } from "~/server/agents/create-job";
import {
  getRegistryPullSecret,
  getRepoBotToken,
  removeInstallation,
  upsertInstallation,
} from "~/server/agents/github-app";
import {
  getGithubAccountByGithubId,
  githubGitIdentity,
} from "~/server/agents/github-token";
import {
  getPullRequestRefs,
  listCommentReactions,
  postIssueCommentReturningId,
  postIssueCommentWithFallback,
} from "~/server/agents/github-issues";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
import {
  getUserRepoPermission,
  isMaintainerOrHigher,
  runUsesRepoCredentials,
} from "~/server/agents/repo-permissions";
import {
  fuzzyPickModel,
  listModelsForUser,
  pickDefaultModel,
  pickLatestGeminiFlash,
  pickLatestGptMini,
  pickLatestSonnet,
} from "~/server/agents/models";
import { repoToNamespace } from "~/server/agents/namespace";
import { resolveModelCredentials } from "~/server/agents/resolve-credentials";
import {
  getRepoWebhookConfig,
  type RepoNetworkPolicy,
} from "~/server/agents/webhook-config";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import {
  buildIssueSystemPrompt,
  buildIssueUserMessage,
  buildResumeSystemPrompt,
  buildResumeUserMessage,
  makeIssueBranch,
} from "~/lib/issue-prompt";
import { parseEffortQuery, providerSupportsEffort } from "~/lib/effort";

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

// ── GitHub payload types ──────────────────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
}

interface GitHubRepository {
  full_name: string;
  clone_url: string;
  default_branch: string;
}

interface IssuePayload {
  action: string;
  issue: GitHubIssue;
  repository: GitHubRepository;
  sender: { id: number; login: string };
}

// `issue_comment` event: a comment on an issue — or on a pull request, which
// GitHub delivers through the same event with `issue.pull_request` set. Drives
// both resuming a run by commenting and the maintainer approval flow for held,
// credential-gated runs.
interface IssueCommentPayload {
  action: string;
  issue: GitHubIssue & { pull_request?: { html_url: string } };
  comment: {
    id: number;
    body: string | null;
    user: { id: number; login: string; type?: string };
  };
  repository: GitHubRepository;
  sender: { id: number; login: string };
}

// Payloads for the GitHub App's lifecycle events, which maintain the
// repo → installation mapping the bot-token broker reads.
interface InstallationRef {
  id: number;
  account: { login: string } | null;
}

// `installation` event: the App is installed/uninstalled, or repos are added to
// / removed from an existing installation (action "added"/"removed").
interface InstallationPayload {
  action: string;
  installation: InstallationRef;
  // Present on install with "selected repositories" and on the "added" action.
  repositories?: { full_name: string }[];
  repositories_added?: { full_name: string }[];
  repositories_removed?: { full_name: string }[];
}

// An issue label of the form `model:<query>` lets the author pick the model for
// that issue's agent — the query is fuzzy-resolved against the available models.
const MODEL_LABEL_PREFIX = "model:";

function modelLabelQuery(labels: { name: string }[]): string | null {
  for (const l of labels) {
    const name = l.name.trim();
    if (name.toLowerCase().startsWith(MODEL_LABEL_PREFIX)) {
      const q = name.slice(MODEL_LABEL_PREFIX.length).trim();
      if (q) return q;
    }
  }
  return null;
}

// An issue label of the form `effort:<level>` lets the author pick the reasoning
// effort for that issue's Claude agent (low|medium|high|xhigh|max). Mirrors the
// `model:` label; only meaningful on Claude runs and ignored otherwise.
const EFFORT_LABEL_PREFIX = "effort:";

function effortLabelQuery(labels: { name: string }[]): string | null {
  for (const l of labels) {
    const name = l.name.trim();
    if (name.toLowerCase().startsWith(EFFORT_LABEL_PREFIX)) {
      const q = name.slice(EFFORT_LABEL_PREFIX.length).trim();
      if (q) return q;
    }
  }
  return null;
}

// An `output:issue` label makes the agent produce sub-task issues instead of a
// pull request: the harness analyses the issue and opens a child issue for the
// most valuable next piece of work.
const OUTPUT_ISSUE_LABEL = "output:issue";

function wantsIssueOutput(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name.trim().toLowerCase() === OUTPUT_ISSUE_LABEL);
}

// ── Shared run prerequisites ──────────────────────────────────────────────────

/**
 * Everything a webhook-triggered run needs that doesn't depend on what
 * triggered it: the Bandolier user linked to the sender, the model (label →
 * repo default → provider default), the reasoning effort, the credentials for
 * the chosen provider (AWS validated up front), the kubeconfig, and the
 * out-of-band PR-writer model. Returns null — with the reason logged under
 * `logCtx` — when any prerequisite is missing, so callers just skip the event.
 */
async function resolveWebhookRun(opts: {
  sender: { id: number; login: string };
  repoFullName: string;
  /** Labels considered for `model:` / `effort:` selection (the issue's). */
  labels: { name: string }[];
  defaultModel: string | null;
  defaultEffort: string | null;
  logCtx: Record<string, unknown>;
}) {
  const { sender, repoFullName, labels, logCtx } = opts;

  // Only user-provided credentials are ever used. Resolve the Bandolier user
  // linked to the GitHub account that triggered the event; skip if none.
  const linked = await getGithubAccountByGithubId(db, String(sender.id));
  if (!linked) {
    console.log("[bandolier:webhook] skipped — sender not a Bandolier user", {
      ...logCtx,
      sender: sender.login,
    });
    return null;
  }

  // Resolve the sender's model credentials (considering this repo's shared
  // credentials per its prefer-credentials flag) and list the models they unlock
  // — across every configured provider, Claude and OpenAI alike.
  const resolved = await resolveModelCredentials(
    db,
    linked.userId,
    repoFullName,
  );
  const { models } = await listModelsForUser(db, linked.userId, repoFullName);
  if (models.length === 0) {
    console.log(
      "[bandolier:webhook] skipped — sender has no model credentials",
      { ...logCtx, sender: sender.login },
    );
    return null;
  }

  // Choose the model. Precedence:
  //   1. An issue label like `model:<query>` fuzzy-selects (e.g. model:opus →
  //      the latest Claude Opus), letting the author pick per issue.
  //   2. The repo's configured default webhook model, when still available.
  //   3. The provider's sensible default (prefers Sonnet).
  const labelQuery = modelLabelQuery(labels);
  let model: string | undefined;
  if (labelQuery) {
    model = fuzzyPickModel(labelQuery, models);
    console.log(
      model
        ? "[bandolier:webhook] model selected from issue label"
        : "[bandolier:webhook] no model matched issue label",
      { ...logCtx, label: `${MODEL_LABEL_PREFIX}${labelQuery}`, model },
    );
  }
  if (!model && opts.defaultModel) {
    model = models.find((m) => m.id === opts.defaultModel)?.id;
    if (model) {
      console.log("[bandolier:webhook] model selected from repo default", {
        ...logCtx,
        model,
      });
    }
  }
  model ??= pickDefaultModel(models);
  if (!model) {
    console.log("[bandolier:webhook] skipped — no models available", {
      ...logCtx,
      sender: sender.login,
    });
    return null;
  }

  // Route credentials by the chosen model's provider (mirrors the deploy path).
  // A model is only ever listed when its provider's credentials resolved, so the
  // matching set is present here.
  const provider = models.find((m) => m.id === model)?.provider;

  // Resolve the reasoning effort, but only for a Claude provider — the OpenAI and
  // Gemini CLIs don't take it. Precedence mirrors the model's: an `effort:<level>`
  // label overrides the repo's configured default; an unknown label value is
  // ignored (falls through to the default, then the CLI default).
  let effort: string | undefined;
  if (provider && providerSupportsEffort(provider)) {
    const effortQuery = effortLabelQuery(labels);
    const labelEffort = effortQuery ? parseEffortQuery(effortQuery) : undefined;
    const repoEffort = opts.defaultEffort
      ? parseEffortQuery(opts.defaultEffort)
      : undefined;
    effort = labelEffort ?? repoEffort;
    if (effortQuery && !labelEffort) {
      console.log("[bandolier:webhook] no effort matched issue label", {
        ...logCtx,
        label: `${EFFORT_LABEL_PREFIX}${effortQuery}`,
      });
    } else if (effort) {
      console.log("[bandolier:webhook] effort selected", {
        ...logCtx,
        effort,
        source: labelEffort ? "issue label" : "repo default",
      });
    }
  }

  const awsCredentials = provider === "bedrock" ? resolved.aws : null;
  const anthropicApiKey =
    provider === "anthropic" ? resolved.anthropicApiKey : null;
  // Subscription credentials apply only when no metered key is set — both can
  // be configured, with the API key taking precedence.
  const anthropicOauthToken =
    provider === "anthropic" && !anthropicApiKey
      ? resolved.anthropicOauthToken
      : null;
  const openaiApiKey = provider === "openai" ? resolved.openaiApiKey : null;
  const codexAuthJson =
    provider === "openai" && !openaiApiKey ? resolved.codexAuthJson : null;
  const geminiApiKey = provider === "gemini" ? resolved.geminiApiKey : null;
  if (
    !awsCredentials &&
    !anthropicApiKey &&
    !anthropicOauthToken &&
    !openaiApiKey &&
    !codexAuthJson &&
    !geminiApiKey
  ) {
    console.log(
      "[bandolier:webhook] skipped — no credentials for the selected model",
      { ...logCtx, sender: sender.login, model },
    );
    return null;
  }

  // Validate AWS credentials so we don't spawn a pod that can't authenticate.
  if (awsCredentials) {
    const validation = await validateAwsCredentials(awsCredentials);
    if (!validation.valid) {
      console.log(
        "[bandolier:webhook] skipped — sender's AWS credentials invalid",
        { ...logCtx, sender: sender.login, error: validation.error },
      );
      return null;
    }
  }

  const kubeconfig = await resolveKubeconfig(db, linked.userId, repoFullName);
  if (!kubeconfig) {
    console.log("[bandolier:webhook] skipped — no repo or sender kubeconfig", {
      ...logCtx,
      sender: sender.login,
    });
    return null;
  }

  // Out-of-band PR writer from the same provider as the chosen model: the latest
  // Sonnet for Claude, the latest GPT mini for OpenAI, the latest Flash for Gemini.
  const prWriterModel =
    provider === "openai"
      ? pickLatestGptMini(models)
      : provider === "gemini"
        ? pickLatestGeminiFlash(models)
        : pickLatestSonnet(models);

  return {
    linked,
    model,
    effort,
    awsCredentials,
    anthropicApiKey,
    anthropicOauthToken,
    openaiApiKey,
    codexAuthJson,
    geminiApiKey,
    kubeconfig,
    prWriterModel,
    // The full resolution result, so callers judging credential provenance
    // (e.g. the repo-credentials maintainer gate) don't re-resolve.
    resolved,
  };
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleIssueOpened(
  payload: IssuePayload,
  prefix: string | null,
  agentImage: string | null,
  defaultModel: string | null,
  defaultEffort: string | null,
  repoSystemPrompt: string | null,
  networkPolicy: RepoNetworkPolicy | undefined,
): Promise<void> {
  const { issue, repository, sender } = payload;

  // Prefix gate: if a trigger phrase is configured, the issue text must contain
  // it; otherwise act on every issue.
  if (prefix) {
    const text = `${issue.title}\n${issue.body ?? ""}`;
    if (!text.includes(prefix)) {
      console.log("[bandolier:webhook] issue skipped — prefix not present", {
        issue: issue.number,
        prefix,
      });
      return;
    }
  }

  const run = await resolveWebhookRun({
    sender,
    repoFullName: repository.full_name,
    labels: issue.labels,
    defaultModel,
    defaultEffort,
    logCtx: { issue: issue.number },
  });
  if (!run) return;
  const {
    linked,
    model,
    effort,
    awsCredentials,
    anthropicApiKey,
    anthropicOauthToken,
    openaiApiKey,
    codexAuthJson,
    geminiApiKey,
    kubeconfig,
    prWriterModel,
    resolved,
  } = run;

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
    outputType: issueOutput ? "issue" : undefined,
    displayName: `#${issue.number}: ${issue.title}`,
    repoUrl: repository.clone_url,
    branch: repository.default_branch,
    model,
    effort,
    // PR title/description are written out-of-band of the task model by a cheap
    // same-provider writer (latest Sonnet for Claude, latest GPT mini for OpenAI).
    prWriterModel,
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
    awsCredentials: awsCredentials ?? undefined,
    anthropicApiKey: anthropicApiKey ?? undefined,
    anthropicOauthToken: anthropicOauthToken ?? undefined,
    openaiApiKey: openaiApiKey ?? undefined,
    codexAuthJson: codexAuthJson ?? undefined,
    geminiApiKey: geminiApiKey ?? undefined,
    kubeconfig,
    agentImage: agentImage ?? undefined,
    imagePullSecret,
    repoSystemPrompt: repoSystemPrompt ?? undefined,
    networkPolicy,
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
  // This is a bot-voice comment ("🤖 Bando picked up this issue…"), so it must
  // only ever be posted by the bot itself — exclusively the GitHub App
  // installation token, attributed to bandolier[bot]. We deliberately do NOT
  // fall back to the legacy service-user PAT or the triggering user's OAuth
  // token: a comment that speaks in the bot's voice but is attributed to a human
  // (or a generic service user) is misleading. On a repo with no App
  // installation there's no bot identity to comment as, so we skip the comment
  // rather than post it under another credential.
  const botToken = await getRepoBotToken(db, repository.full_name, Date.now());
  const taskUrl = `${env.BETTER_AUTH_URL}/repo/${repository.full_name}`;
  const commentBody =
    `🤖 Bando picked up this issue and is working on it.\n\n` +
    `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`)`;
  const postedBy = await postIssueCommentWithFallback(
    [{ token: botToken, source: "app-installation" }],
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
 * thing a comment triggers.
 */
async function handleIssueComment(
  payload: IssueCommentPayload,
  prefix: string | null,
  agentImage: string | null,
  defaultModel: string | null,
  defaultEffort: string | null,
  repoSystemPrompt: string | null,
  networkPolicy: RepoNetworkPolicy | undefined,
): Promise<void> {
  const { issue, comment, repository } = payload;
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
    defaultModel,
    defaultEffort,
    logCtx,
  });
  if (!run) return;
  const {
    linked,
    model,
    effort,
    awsCredentials,
    anthropicApiKey,
    anthropicOauthToken,
    openaiApiKey,
    codexAuthJson,
    geminiApiKey,
    kubeconfig,
    prWriterModel,
  } = run;

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
    model,
    effort,
    prWriterModel,
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
    awsCredentials: awsCredentials ?? undefined,
    anthropicApiKey: anthropicApiKey ?? undefined,
    anthropicOauthToken: anthropicOauthToken ?? undefined,
    openaiApiKey: openaiApiKey ?? undefined,
    codexAuthJson: codexAuthJson ?? undefined,
    geminiApiKey: geminiApiKey ?? undefined,
    kubeconfig,
    agentImage: agentImage ?? undefined,
    imagePullSecret,
    repoSystemPrompt: repoSystemPrompt ?? undefined,
    networkPolicy,
  });

  // Acknowledge in the thread, bot-voice only (see the matching comment on the
  // issue-opened path for why there is deliberately no token fallback).
  const botToken = await getRepoBotToken(db, repository.full_name, Date.now());
  const taskUrl = `${env.BETTER_AUTH_URL}/repo/${repository.full_name}`;
  const ackBody =
    `🤖 Bando is resuming work on this ${kind}.\n\n` +
    `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`, resumes \`${parent.jobName}\`)`;
  const postedBy = await postIssueCommentWithFallback(
    [{ token: botToken, source: "app-installation" }],
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

// Approval / decline commands a maintainer can reply with to act on a held run.
const APPROVE_COMMANDS = ["/bando approve", "/bando-approve"];
const DECLINE_COMMANDS = ["/bando decline", "/bando-decline", "/bando deny"];
// Reaction contents that count as an approval when placed on the bot's
// approval-request comment (a thumbs-up or a rocket).
const APPROVAL_REACTIONS = new Set(["+1", "rocket", "hooray"]);

/**
 * Dispatches a held run after a maintainer's approval: atomically claims the row
 * (so two racing approvals can't both fire), creates the agent job, and posts a
 * confirmation. No-op if the row was already resolved.
 */
async function approveAndDispatch(
  run: Awaited<ReturnType<typeof getUnresolvedPendingRun>>,
  approverLogin: string,
  botToken: string | null,
): Promise<void> {
  if (!run) return;
  const claimed = await markResolved(db, run.id, "dispatched", approverLogin);
  if (!claimed) return; // already resolved by a concurrent approval

  let jobName: string;
  try {
    jobName = await dispatchPendingRun(run);
  } catch (err) {
    console.error("[bandolier:webhook] failed to dispatch approved run", {
      issue: run.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  console.log("[bandolier:webhook] approved run dispatched", {
    issue: run.issueNumber,
    approver: approverLogin,
    job: jobName,
  });
  if (botToken) {
    const taskUrl = `${env.BETTER_AUTH_URL}/repo/${run.repoFullName}`;
    const body =
      `🤖 Approved by @${approverLogin}. Bando is now working on this issue.\n\n` +
      `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`)`;
    await postIssueCommentWithFallback(
      [{ token: botToken, source: "app-installation" }],
      run.repoFullName,
      run.issueNumber,
      body,
    );
  }
}

/**
 * Handles an `issue_comment` event for the credential-approval flow. A held run
 * (see handleIssueOpened) is dispatched when a maintainer-or-higher user either
 * replies with `/bando approve` or reacts 👍/🚀 to the bot's approval comment.
 * The comment's text is checked first; if it isn't a command, we re-check the
 * approval comment's reactions (GitHub doesn't deliver reaction webhooks, so any
 * later comment activity on the issue is used as a cheap trigger to poll them).
 *
 * Returns true when the issue has an unresolved held run — the comment then
 * belongs to the approval flow and must not also resume a run.
 */
async function handleApprovalComment(
  payload: IssueCommentPayload,
): Promise<boolean> {
  if (payload.action !== "created") return false;

  const repoFullName = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const run = await getUnresolvedPendingRun(db, repoFullName, issueNumber);
  if (!run) return false;

  const botToken = await getRepoBotToken(db, repoFullName, Date.now());
  const text = (payload.comment.body ?? "").toLowerCase();
  const isApproveCmd = APPROVE_COMMANDS.some((c) => text.includes(c));
  const isDeclineCmd = DECLINE_COMMANDS.some((c) => text.includes(c));

  // A command in the comment is attributed to its sender — verify their
  // privilege before acting. Ignore the bot's own comments.
  if (isApproveCmd || isDeclineCmd) {
    const permToken = botToken ?? null;
    const permission = permToken
      ? await getUserRepoPermission(
          permToken,
          repoFullName,
          payload.sender.login,
        )
      : "none";
    if (!isMaintainerOrHigher(permission)) {
      console.log(
        "[bandolier:webhook] approval command ignored — sender not a maintainer",
        { issue: issueNumber, sender: payload.sender.login, permission },
      );
      return true;
    }
    if (isDeclineCmd) {
      await markResolved(db, run.id, "declined", payload.sender.login);
      console.log("[bandolier:webhook] held run declined", {
        issue: issueNumber,
        by: payload.sender.login,
      });
      if (botToken) {
        await postIssueCommentWithFallback(
          [{ token: botToken, source: "app-installation" }],
          repoFullName,
          issueNumber,
          `🤖 Declined by @${payload.sender.login}. This run will not be dispatched.`,
        );
      }
      return true;
    }
    await approveAndDispatch(run, payload.sender.login, botToken);
    return true;
  }

  // Not a command — poll reactions on the bot's approval comment for an
  // approving 👍/🚀 from a maintainer. (GitHub sends no reaction webhook, so we
  // piggyback on comment activity to check.)
  if (run.approvalCommentId && botToken) {
    try {
      const reactions = await listCommentReactions(
        botToken,
        repoFullName,
        Number(run.approvalCommentId),
      );
      for (const r of reactions) {
        if (!APPROVAL_REACTIONS.has(r.content) || !r.user) continue;
        const permission = await getUserRepoPermission(
          botToken,
          repoFullName,
          r.user.login,
        );
        if (isMaintainerOrHigher(permission)) {
          await approveAndDispatch(run, r.user.login, botToken);
          return true;
        }
      }
    } catch (err) {
      console.warn("[bandolier:webhook] failed to read approval reactions", {
        issue: issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return true;
}

/**
 * Maintains the repo → installation mapping from the App's `installation` and
 * `installation_repositories` events. Both deliver the same shape; the action
 * distinguishes adds from removes:
 *   - created / added   → record the listed repos under this installation
 *   - deleted / removed → drop the listed repos (or all, on a full uninstall)
 */
async function handleInstallation(
  payload: InstallationPayload,
  fullUninstall: boolean,
): Promise<void> {
  const installationId = String(payload.installation.id);
  const accountLogin = payload.installation.account?.login ?? null;

  const added = payload.repositories ?? payload.repositories_added ?? [];
  for (const repo of added) {
    await upsertInstallation(db, repo.full_name, installationId, accountLogin);
  }

  const removed = payload.repositories_removed ?? [];
  for (const repo of removed) {
    await removeInstallation(db, repo.full_name);
  }

  // A full uninstall carries the installation's repo list under `repositories`;
  // those rows must be dropped, not added.
  if (fullUninstall) {
    for (const repo of payload.repositories ?? []) {
      await removeInstallation(db, repo.full_name);
    }
  }

  console.log("[bandolier:webhook] installation event processed", {
    action: payload.action,
    installation: installationId,
    added: added.length,
    removed:
      removed.length +
      (fullUninstall ? (payload.repositories?.length ?? 0) : 0),
  });
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
      const repoConfig = repoFullName
        ? await getRepoWebhookConfig(db, repoFullName)
        : null;
      await handleIssueOpened(
        payload as IssuePayload,
        repoConfig?.prefix ?? null,
        repoConfig?.agentImage ?? null,
        repoConfig?.defaultWebhookModel ?? null,
        repoConfig?.defaultWebhookEffort ?? null,
        repoConfig?.systemPrompt ?? null,
        repoConfig?.networkPolicy,
      );
    } else if (
      event === "issue_comment" &&
      (payload as IssueCommentPayload).action === "created"
    ) {
      // A held, credential-gated run claims the issue's comments first: they
      // approve/decline it rather than resuming anything. Otherwise a comment
      // on an issue or PR resumes that item's most recent run.
      const gated = await handleApprovalComment(payload as IssueCommentPayload);
      if (!gated) {
        const repoConfig = repoFullName
          ? await getRepoWebhookConfig(db, repoFullName)
          : null;
        await handleIssueComment(
          payload as IssueCommentPayload,
          repoConfig?.prefix ?? null,
          repoConfig?.agentImage ?? null,
          repoConfig?.defaultWebhookModel ?? null,
          repoConfig?.defaultWebhookEffort ?? null,
          repoConfig?.systemPrompt ?? null,
          repoConfig?.networkPolicy,
        );
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
