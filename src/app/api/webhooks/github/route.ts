import crypto from "crypto";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { validateAwsCredentials } from "~/server/agents/aws";
import { createAgentJob } from "~/server/agents/create-job";
import {
  getRepoBotToken,
  removeInstallation,
  upsertInstallation,
} from "~/server/agents/github-app";
import {
  getGithubAccountByGithubId,
  githubGitIdentity,
} from "~/server/agents/github-token";
import { postIssueComment } from "~/server/agents/github-issues";
import {
  getTokenRepoRole,
  isApprovalReaction,
  isMaintainerRole,
  userHasMaintainerAccess,
} from "~/server/agents/github-permissions";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
import {
  fuzzyPickModel,
  listModelsForUser,
  pickDefaultModel,
  pickLatestGeminiFlash,
  pickLatestGptMini,
  pickLatestSonnet,
} from "~/server/agents/models";
import { repoToNamespace } from "~/server/agents/namespace";
import { usesRepoCredentials } from "~/server/agents/repo-credential-gate";
import { resolveModelCredentials } from "~/server/agents/resolve-credentials";
import { getRepoWebhookConfig } from "~/server/agents/webhook-config";
import { db } from "~/server/db";
import { pendingApproval } from "~/server/db/schema";
import {
  buildIssueSystemPrompt,
  buildIssueUserMessage,
  makeIssueBranch,
} from "~/lib/issue-prompt";

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

// `issue_comment` event: used for the `@bando approve` approval channel.
interface IssueCommentPayload {
  action: string;
  issue: { number: number };
  comment: { id: number; body: string };
  repository: GitHubRepository;
  sender: { id: number; login: string };
}

// `reaction` event (App-subscribed, preview): a reaction added to an issue
// comment. Used so a maintainer can approve a gated run by reacting to Bando's
// approval-request comment.
interface ReactionPayload {
  action: string;
  reaction: { content: string; subject_type: string };
  comment: { id: number };
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

// An `output:issue` label makes the agent produce sub-task issues instead of a
// pull request: the harness analyses the issue and opens a child issue for the
// most valuable next piece of work.
const OUTPUT_ISSUE_LABEL = "output:issue";

function wantsIssueOutput(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name.trim().toLowerCase() === OUTPUT_ISSUE_LABEL);
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleIssueOpened(
  payload: IssuePayload,
  prefix: string | null,
  agentImage: string | null,
  defaultModel: string | null,
  // Set when re-entering after a maintainer approved a previously-gated run:
  // the repo-credential maintainer gate is skipped (a maintainer has already
  // signed off), and the trigger-prefix/label gates are likewise not re-applied.
  opts?: { bypassMaintainerGate?: boolean },
): Promise<void> {
  const { issue, repository, sender } = payload;
  const bypassGate = opts?.bypassMaintainerGate ?? false;

  // Prefix gate: if a trigger phrase is configured, the issue text must contain
  // it; otherwise act on every issue.
  if (prefix && !bypassGate) {
    const text = `${issue.title}\n${issue.body ?? ""}`;
    if (!text.includes(prefix)) {
      console.log("[bandolier:webhook] issue skipped — prefix not present", {
        issue: issue.number,
        prefix,
      });
      return;
    }
  }

  // Label gate: if GITHUB_TRIGGER_LABEL is set, only act on matching issues.
  if (env.GITHUB_TRIGGER_LABEL && !bypassGate) {
    const hasLabel = issue.labels.some(
      (l) => l.name === env.GITHUB_TRIGGER_LABEL,
    );
    if (!hasLabel) {
      console.log("[bandolier:webhook] issue skipped — label not matched", {
        issue: issue.number,
        required: env.GITHUB_TRIGGER_LABEL,
      });
      return;
    }
  }

  // Only user-provided credentials are ever used. Resolve the Bandolier user
  // linked to the GitHub account that opened the issue; skip if none.
  const linked = await getGithubAccountByGithubId(db, String(sender.id));
  if (!linked) {
    console.log(
      "[bandolier:webhook] issue skipped — sender not a Bandolier user",
      {
        issue: issue.number,
        sender: sender.login,
      },
    );
    return;
  }

  // Resolve the issue author's model credentials (considering this repo's shared
  // credentials per its prefer-credentials flag) and list the models they unlock
  // — across every configured provider, Claude and OpenAI alike.
  const resolved = await resolveModelCredentials(
    db,
    linked.userId,
    repository.full_name,
  );
  const { models } = await listModelsForUser(
    db,
    linked.userId,
    repository.full_name,
  );
  if (models.length === 0) {
    console.log(
      "[bandolier:webhook] issue skipped — sender has no model credentials",
      { issue: issue.number, sender: sender.login },
    );
    return;
  }

  // Choose the model. Precedence:
  //   1. An issue label like `model:<query>` fuzzy-selects (e.g. model:opus →
  //      the latest Claude Opus), letting the author pick per issue.
  //   2. The repo's configured default webhook model, when still available.
  //   3. The provider's sensible default (prefers Sonnet).
  const labelQuery = modelLabelQuery(issue.labels);
  let model: string | undefined;
  if (labelQuery) {
    model = fuzzyPickModel(labelQuery, models);
    console.log(
      model
        ? "[bandolier:webhook] model selected from issue label"
        : "[bandolier:webhook] no model matched issue label",
      {
        issue: issue.number,
        label: `${MODEL_LABEL_PREFIX}${labelQuery}`,
        model,
      },
    );
  }
  if (!model && defaultModel) {
    model = models.find((m) => m.id === defaultModel)?.id;
    if (model) {
      console.log("[bandolier:webhook] model selected from repo default", {
        issue: issue.number,
        model,
      });
    }
  }
  model ??= pickDefaultModel(models);
  if (!model) {
    console.log("[bandolier:webhook] issue skipped — no models available", {
      issue: issue.number,
      sender: sender.login,
    });
    return;
  }

  // Route credentials by the chosen model's provider (mirrors the deploy path).
  // A model is only ever listed when its provider's credentials resolved, so the
  // matching set is present here.
  const provider = models.find((m) => m.id === model)?.provider;
  const awsCredentials = provider === "bedrock" ? resolved.aws : null;
  const anthropicApiKey =
    provider === "anthropic" ? resolved.anthropicApiKey : null;
  const openaiApiKey = provider === "openai" ? resolved.openaiApiKey : null;
  const geminiApiKey = provider === "gemini" ? resolved.geminiApiKey : null;
  if (!awsCredentials && !anthropicApiKey && !openaiApiKey && !geminiApiKey) {
    console.log(
      "[bandolier:webhook] issue skipped — no credentials for the selected model",
      { issue: issue.number, sender: sender.login, model },
    );
    return;
  }

  // Validate AWS credentials so we don't spawn a pod that can't authenticate.
  if (awsCredentials) {
    const validation = await validateAwsCredentials(awsCredentials);
    if (!validation.valid) {
      console.log(
        "[bandolier:webhook] issue skipped — sender's AWS credentials invalid",
        {
          issue: issue.number,
          sender: sender.login,
          error: validation.error,
        },
      );
      return;
    }
  }

  console.log("[bandolier:webhook] issue opened", {
    repo: repository.full_name,
    issue: issue.number,
    title: issue.title,
    sender: sender.login,
    model,
  });

  const kubeconfig = await resolveKubeconfig(
    db,
    linked.userId,
    repository.full_name,
  );
  if (!kubeconfig) {
    console.log(
      "[bandolier:webhook] issue skipped — no server or sender kubeconfig",
      {
        issue: issue.number,
        sender: sender.login,
      },
    );
    return;
  }

  // Out-of-band PR writer from the same provider as the chosen model: the latest
  // Sonnet for Claude, the latest GPT mini for OpenAI, the latest Flash for Gemini.
  const prWriterModel =
    provider === "openai"
      ? pickLatestGptMini(models)
      : provider === "gemini"
        ? pickLatestGeminiFlash(models)
        : pickLatestSonnet(models);

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

  // ── Repo-credential maintainer gate ────────────────────────────────────────
  // When this run would execute with repo-level shared credentials (a repo
  // kubeconfig or repo AI API keys), only a collaborator with maintainer+ access
  // may dispatch it. A less-privileged issue opener gets a bot comment instead;
  // a maintainer then approves it (by reacting to that comment), at which point
  // the run is dispatched. Runs on the opener's own credentials are never gated.
  if (!bypassGate) {
    const gated = await usesRepoCredentials(
      db,
      linked.userId,
      repository.full_name,
    );
    if (gated) {
      const senderRole = linked.accessToken
        ? await getTokenRepoRole(linked.accessToken, repository.full_name)
        : "none";
      if (!isMaintainerRole(senderRole)) {
        await requestApproval(payload);
        return;
      }
      console.log(
        "[bandolier:webhook] repo-credential run authorized — sender is maintainer",
        { issue: issue.number, sender: sender.login, role: senderRole },
      );
    }
  }

  // Attribute commits to the issue author via their GitHub no-reply address, so
  // GitHub links them to that account regardless of the sender's email privacy.
  const gitIdentity = githubGitIdentity(sender.id, sender.login);

  const jobName = await createAgentJob({
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
    openaiApiKey: openaiApiKey ?? undefined,
    geminiApiKey: geminiApiKey ?? undefined,
    kubeconfig,
    agentImage: agentImage ?? undefined,
  });

  // Notify the issue author that the task was received and is being worked on.
  // This is a bot-voice action, so prefer the GitHub App installation token
  // (comment is attributed to bandolier[bot]); fall back to the legacy service
  // user PAT, then to the triggering user's token, for deployments without the
  // App installed.
  const botToken = await getRepoBotToken(db, repository.full_name, Date.now());
  const commentToken =
    botToken ?? env.BANDOLIER_GITHUB_TOKEN ?? linked.accessToken;
  if (commentToken) {
    const taskUrl = `${env.BETTER_AUTH_URL}/repo/${repository.full_name}`;
    const commentBody =
      `🤖 Bando picked up this issue and is working on it.\n\n` +
      `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`)`;
    try {
      await postIssueComment(
        commentToken,
        repository.full_name,
        issue.number,
        commentBody,
      );
      console.log("[bandolier:webhook] issue comment posted", {
        issue: issue.number,
        job: jobName,
      });
    } catch (err) {
      console.warn("[bandolier:webhook] failed to post issue comment", {
        issue: issue.number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Marker line in the bot's approval-request comment; reused to recognize our own
// comment and to detect a maintainer's `@bando approve` reply.
const APPROVAL_COMMENT_MARKER = "<!-- bandolier:approval-request -->";
const APPROVE_COMMAND = /@bando\s+approve\b/i;

/**
 * Records a pending approval for a gated run and posts a bot comment asking a
 * maintainer to sign off. Stores everything needed to dispatch the agent later
 * (re-resolving credentials at approval time), keyed off the bot comment so a
 * maintainer reacting to it (👍/❤️/🎉/🚀) approves the run.
 */
async function requestApproval(payload: IssuePayload): Promise<void> {
  const { issue, repository, sender } = payload;

  console.log(
    "[bandolier:webhook] repo-credential run requires maintainer approval",
    { issue: issue.number, sender: sender.login, repo: repository.full_name },
  );

  // Replace any earlier pending approval for this issue (e.g. the issue was
  // edited and redelivered) so there's a single live request per issue.
  await db
    .delete(pendingApproval)
    .where(eq(pendingApproval.issueUrl, issue.html_url));

  const id = randomUUID();
  await db.insert(pendingApproval).values({
    id,
    repoFullName: repository.full_name,
    issueNumber: String(issue.number),
    issueUrl: issue.html_url,
    issueTitle: issue.title,
    issueBody: issue.body ?? "",
    issueLabels: JSON.stringify(issue.labels.map((l) => l.name)),
    cloneUrl: repository.clone_url,
    defaultBranch: repository.default_branch,
    requestedByGithubId: String(sender.id),
    requestedByLogin: sender.login,
  });

  // Post the request as the bot (App installation token preferred, then the
  // legacy PAT). We need a bot/maintainer-scoped token here both to attribute
  // the comment and, later, to read collaborator permissions — the opener's own
  // token can't be trusted to vouch for itself.
  const botToken =
    (await getRepoBotToken(db, repository.full_name, Date.now())) ??
    env.BANDOLIER_GITHUB_TOKEN ??
    null;
  if (!botToken) {
    console.warn(
      "[bandolier:webhook] cannot request approval — no bot token (App not installed and no BANDOLIER_GITHUB_TOKEN)",
      { issue: issue.number },
    );
    return;
  }

  const commentBody =
    `${APPROVAL_COMMENT_MARKER}\n` +
    `🔒 **Maintainer approval required.** @${sender.login} asked Bando to work on this issue, ` +
    `but it would run with this repository's shared credentials, which only maintainers may use.\n\n` +
    `A maintainer (or admin) can approve it by **reacting to this comment** with 👍, ❤️, 🎉, or 🚀, ` +
    `or by replying \`@bando approve\`. The agent will then be dispatched.`;

  try {
    const commentId = await postIssueComment(
      botToken,
      repository.full_name,
      issue.number,
      commentBody,
    );
    await db
      .update(pendingApproval)
      .set({ commentId: String(commentId) })
      .where(eq(pendingApproval.id, id));
    console.log("[bandolier:webhook] approval request posted", {
      issue: issue.number,
      comment: commentId,
    });
  } catch (err) {
    console.warn("[bandolier:webhook] failed to post approval request", {
      issue: issue.number,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Loads a pending approval for an issue and, if `approverLogin` has maintainer+
 * access on the repo, dispatches the agent (bypassing the gate, since a
 * maintainer has signed off) and clears the pending row. Drives both approval
 * channels: a reaction on the bot comment and an `@bando approve` reply.
 */
async function approvePendingRun(
  repoFullName: string,
  issueNumber: number,
  approverLogin: string,
  prefix: string | null,
  agentImage: string | null,
  defaultModel: string | null,
): Promise<void> {
  const rows = await db
    .select()
    .from(pendingApproval)
    .where(eq(pendingApproval.repoFullName, repoFullName));
  const row = rows.find((r) => r.issueNumber === String(issueNumber));
  if (!row) return;

  // Verify the approver really is a maintainer, read with a bot/maintainer token
  // (the only token we can trust to report another user's permission).
  const botToken =
    (await getRepoBotToken(db, repoFullName, Date.now())) ??
    env.BANDOLIER_GITHUB_TOKEN ??
    null;
  if (!botToken) {
    console.warn(
      "[bandolier:webhook] cannot verify approver — no bot token available",
      { repo: repoFullName, issue: issueNumber },
    );
    return;
  }
  const ok = await userHasMaintainerAccess(
    botToken,
    repoFullName,
    approverLogin,
  );
  if (!ok) {
    console.log(
      "[bandolier:webhook] approval ignored — approver not maintainer",
      {
        repo: repoFullName,
        issue: issueNumber,
        approver: approverLogin,
      },
    );
    return;
  }

  // Clear the row first so concurrent deliveries (reaction + reply) can't double
  // dispatch; if dispatch then fails, the request can simply be re-made.
  await db.delete(pendingApproval).where(eq(pendingApproval.id, row.id));

  console.log(
    "[bandolier:webhook] maintainer approved gated run — dispatching",
    {
      repo: repoFullName,
      issue: issueNumber,
      approver: approverLogin,
    },
  );

  let labels: { name: string }[] = [];
  try {
    labels = (JSON.parse(row.issueLabels) as string[]).map((name) => ({
      name,
    }));
  } catch {
    labels = [];
  }

  await handleIssueOpened(
    {
      action: "opened",
      issue: {
        number: Number(row.issueNumber),
        title: row.issueTitle,
        body: row.issueBody,
        html_url: row.issueUrl,
        labels,
      },
      repository: {
        full_name: row.repoFullName,
        clone_url: row.cloneUrl,
        default_branch: row.defaultBranch,
      },
      sender: {
        id: Number(row.requestedByGithubId),
        login: row.requestedByLogin,
      },
    },
    prefix,
    agentImage,
    defaultModel,
    { bypassMaintainerGate: true },
  );
}

/**
 * Handles `issue_comment` events: a maintainer can approve a gated run by
 * replying `@bando approve`. (The reaction channel is handled by the separate
 * `reaction` event.) The commenter's own login is verified as maintainer+
 * inside approvePendingRun.
 */
async function handleIssueComment(
  payload: IssueCommentPayload,
  prefix: string | null,
  agentImage: string | null,
  defaultModel: string | null,
): Promise<void> {
  if (payload.action !== "created" && payload.action !== "edited") return;
  // Ignore the bot's own comments (and any other comment lacking the command).
  if (payload.comment.body.includes(APPROVAL_COMMENT_MARKER)) return;
  if (!APPROVE_COMMAND.test(payload.comment.body)) return;

  await approvePendingRun(
    payload.repository.full_name,
    payload.issue.number,
    payload.sender.login,
    prefix,
    agentImage,
    defaultModel,
  );
}

/**
 * Handles `reaction` events on issue comments: a maintainer reacting to Bando's
 * approval-request comment (👍/❤️/🎉/🚀) dispatches the gated run. GitHub only
 * delivers these when the App subscribes to the (preview) reaction event; the
 * `@bando approve` reply is the always-available fallback.
 */
async function handleReaction(
  payload: ReactionPayload,
  prefix: string | null,
  agentImage: string | null,
  defaultModel: string | null,
): Promise<void> {
  if (payload.action !== "created") return;
  if (payload.reaction.subject_type !== "comment") return;
  if (!isApprovalReaction(payload.reaction.content)) return;

  // The reaction must be on a tracked approval-request comment for this issue.
  const rows = await db
    .select()
    .from(pendingApproval)
    .where(eq(pendingApproval.repoFullName, payload.repository.full_name));
  const row = rows.find(
    (r) => r.commentId && r.commentId === String(payload.comment.id),
  );
  if (!row) return;

  await approvePendingRun(
    payload.repository.full_name,
    Number(row.issueNumber),
    payload.sender.login,
    prefix,
    agentImage,
    defaultModel,
  );
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
      );
    } else if (event === "issue_comment") {
      // A maintainer can approve a gated run by replying `@bando approve`.
      const repoConfig = repoFullName
        ? await getRepoWebhookConfig(db, repoFullName)
        : null;
      await handleIssueComment(
        payload as IssueCommentPayload,
        repoConfig?.prefix ?? null,
        repoConfig?.agentImage ?? null,
        repoConfig?.defaultWebhookModel ?? null,
      );
    } else if (event === "reaction") {
      // A maintainer reacting to Bando's approval-request comment dispatches the
      // gated run (App must subscribe to the reaction event for this to arrive).
      const repoConfig = repoFullName
        ? await getRepoWebhookConfig(db, repoFullName)
        : null;
      await handleReaction(
        payload as ReactionPayload,
        repoConfig?.prefix ?? null,
        repoConfig?.agentImage ?? null,
        repoConfig?.defaultWebhookModel ?? null,
      );
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
