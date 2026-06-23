import crypto from "crypto";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { validateAwsCredentials } from "~/server/agents/aws";
import { createAgentJob } from "~/server/agents/create-job";
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
import { postIssueCommentWithFallback } from "~/server/agents/github-issues";
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
import { resolveModelCredentials } from "~/server/agents/resolve-credentials";
import { getRepoWebhookConfig } from "~/server/agents/webhook-config";
import { db } from "~/server/db";
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
  repoSystemPrompt: string | null,
  networkPolicy:
    | { allowPrivateEgress: boolean; allowAllPortsEgress: boolean }
    | undefined,
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

  // Label gate: if GITHUB_TRIGGER_LABEL is set, only act on matching issues.
  if (env.GITHUB_TRIGGER_LABEL) {
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

  // Attribute commits to the issue author via their GitHub no-reply address, so
  // GitHub links them to that account regardless of the sender's email privacy.
  const gitIdentity = githubGitIdentity(sender.id, sender.login);

  // A custom image on a private ghcr.io package needs pull credentials — use the
  // issue author's GitHub OAuth token (GHCR rejects App installation tokens).
  // Best-effort: a failure leaves the cluster to pull with its own node creds.
  const imagePullSecret = agentImage
    ? (getRegistryPullSecret(agentImage, linked.accessToken) ?? undefined)
    : undefined;

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
    imagePullSecret,
    repoSystemPrompt: repoSystemPrompt ?? undefined,
    networkPolicy,
  });

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
        repoConfig?.systemPrompt ?? null,
        repoConfig?.networkPolicy,
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
