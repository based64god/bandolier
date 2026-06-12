import crypto from "crypto";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { getUserAnthropicKey } from "~/server/agents/anthropic";
import { validateAwsCredentials } from "~/server/agents/aws";
import { createAgentJob } from "~/server/agents/create-job";
import {
  getGithubAccountByGithubId,
  githubGitIdentity,
} from "~/server/agents/github-token";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
import {
  listModelsForUser,
  pickDefaultModel,
  pickLatestSonnet,
} from "~/server/agents/models";
import { repoToNamespace } from "~/server/agents/namespace";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
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

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleIssueOpened(
  payload: IssuePayload,
  prefix: string | null,
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

  const awsCredentials = await getUserAwsCredentials(db, linked.userId);
  const anthropicApiKey = awsCredentials
    ? null
    : await getUserAnthropicKey(db, linked.userId);

  if (!awsCredentials && !anthropicApiKey) {
    console.log(
      "[bandolier:webhook] issue skipped — sender has no model credentials",
      {
        issue: issue.number,
        sender: sender.login,
      },
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
  });

  const kubeconfig = await resolveKubeconfig(db, linked.userId);
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

  // Pick a default model from the sender's provider (prefers Sonnet) — there is
  // no UI to choose one for webhook-triggered agents.
  const { models } = await listModelsForUser(db, linked.userId);
  const model = pickDefaultModel(models);
  if (!model) {
    console.log("[bandolier:webhook] issue skipped — no models available", {
      issue: issue.number,
      sender: sender.login,
    });
    return;
  }

  const agentBranch = makeIssueBranch(issue.number, issue.title);

  // Attribute commits to the issue author via their GitHub no-reply address, so
  // GitHub links them to that account regardless of the sender's email privacy.
  const gitIdentity = githubGitIdentity(sender.id, sender.login);

  await createAgentJob({
    namespace: repoToNamespace(repository.full_name),
    // Build the prompt here (no operator context): the issue context is stored
    // as CLAUDE_TASK and shown in the dashboard; the instructional framing goes
    // in the system prompt.
    task: buildIssueUserMessage(
      { number: issue.number, title: issue.title, body: issue.body ?? "" },
      "",
    ),
    systemPrompt: buildIssueSystemPrompt({ title: issue.title }, agentBranch),
    agentBranch,
    displayName: `#${issue.number}: ${issue.title}`,
    repoUrl: repository.clone_url,
    branch: repository.default_branch,
    model,
    // PR title/description are written by the latest Sonnet, out-of-band of the
    // task model (which may be Opus/Haiku for webhook runs).
    prWriterModel: pickLatestSonnet(models),
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
    kubeconfig,
  });
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const event = req.headers.get("x-github-event");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload = JSON.parse(rawBody);

  // Select the verification secret by the repo named in the (still-untrusted)
  // payload: the per-repo secret if configured, else the global env secret. The
  // signature check below is what actually authenticates — a forged repo name
  // can't produce a valid signature without that repo's secret.
  const repoFullName: string | undefined = (payload as IssuePayload)?.repository
    ?.full_name;
  const repoConfig = repoFullName
    ? await getRepoWebhookConfig(db, repoFullName)
    : null;
  const secret = repoConfig?.secret ?? env.GITHUB_WEBHOOK_SECRET;

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
      await handleIssueOpened(
        payload as IssuePayload,
        repoConfig?.prefix ?? null,
      );
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
