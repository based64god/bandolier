import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as RepoPermsModule from "~/server/agents/repo-permissions";
import type { ResolvedWebhookRun } from "~/server/webhooks/resolve-run";

// The webhook HAPPY path, end-to-end against a real Postgres: an opened issue on
// a triggering repo whose run does NOT use the repo's shared credentials skips
// the maintainer gate and reaches createAgentJob, which writes a real task_run.
// The credential-resolution step (resolveWebhookRun) is canned so no GitHub /
// model lookups run; runUsesRepoCredentials returns false so the gate is
// bypassed; the k8s client and bot acknowledgement are faked. The route's real
// HMAC check, the real repo_webhook_config read, and the recordRun insert all
// run for real.
const resolveWebhookRun = vi.fn<() => Promise<ResolvedWebhookRun | null>>();
vi.mock("~/server/webhooks/resolve-run", () => ({
  resolveWebhookRun: (...a: unknown[]) => resolveWebhookRun(...(a as [])),
}));

const runUsesRepoCredentials = vi
  .fn<() => Promise<boolean>>()
  .mockResolvedValue(false);
vi.mock("~/server/agents/repo-permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof RepoPermsModule>()),
  runUsesRepoCredentials: () => runUsesRepoCredentials(),
}));

// The bot acknowledgement comment is posted after the run is created; fake it so
// no GitHub call is made (the task_run already exists by then either way).
vi.mock("~/server/webhooks/bot-ack", () => ({
  postBotAck: () => Promise.resolve("app-installation"),
}));

// Fake the whole cluster client so createAgentJob's namespace / SA / job /
// secret / PDB / network-policy calls no-op; createNamespacedJob returns a uid.
vi.mock("~/server/k8s/client", () => ({
  getCoreV1Api: () => ({
    createNamespace: () => Promise.resolve({}),
    createNamespacedServiceAccount: () => Promise.resolve({}),
    createNamespacedSecret: () => Promise.resolve({}),
  }),
  getBatchV1Api: () => ({
    createNamespacedJob: () => Promise.resolve({ metadata: { uid: "u" } }),
  }),
  getNetworkingV1Api: () => ({
    createNamespacedNetworkPolicy: () => Promise.resolve({}),
    replaceNamespacedNetworkPolicy: () => Promise.resolve({}),
  }),
  getPolicyV1Api: () => ({
    createNamespacedPodDisruptionBudget: () => Promise.resolve({}),
  }),
}));

const { POST } = await import("~/app/api/webhooks/github/route");
const { DEFAULT_HARNESS_IMAGE } = await import("~/server/agents/create-job");
const { taskRun } = await import("~/server/db/schema");
const { signWebhook } = await import("~/test/integration/auth-material");
const { db, resetDb } = await import("~/test/integration/harness");
const { seedRepoWebhookConfig } = await import("~/test/integration/seed");

const SECRET = "test-webhook-secret"; // matches the integration env block
const REPO = "acme/widgets";
const LINKED_USER = "linked-user-99";

function webhookPost(event: string, payload: unknown): NextRequest {
  const raw = JSON.stringify(payload);
  return new NextRequest("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signWebhook(raw, SECRET),
    },
    body: raw,
  });
}

function issueOpenedPayload() {
  return {
    action: "opened",
    issue: {
      number: 7,
      title: "please fix the thing",
      body: "details",
      html_url: `https://github.com/${REPO}/issues/7`,
      labels: [] as { name: string }[],
    },
    repository: {
      full_name: REPO,
      clone_url: `https://github.com/${REPO}.git`,
      default_branch: "main",
    },
    sender: { id: 4242, login: "contributor" },
  };
}

describe("webhook issue-opened happy path (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    resolveWebhookRun.mockReset().mockResolvedValue({
      linked: { userId: LINKED_USER, accessToken: "gho_token" },
      model: "claude-sonnet-4-5",
      // A valid spec base: kubeconfig + an Anthropic key so resolveProvider
      // succeeds and createAgentJob runs through the faked cluster to recordRun.
      specBase: {
        model: "claude-sonnet-4-5",
        kubeconfig: "kc",
        anthropicApiKey: "sk-ant-happy",
      },
      resolved: {} as ResolvedWebhookRun["resolved"],
    });
    runUsesRepoCredentials.mockReset().mockResolvedValue(false);
    // The repo opts into webhooks (trigger on all events).
    await seedRepoWebhookConfig(REPO, { triggerOnAllEvents: true });
  });

  it("dispatches the run and writes a real task_run", async () => {
    const res = await POST(webhookPost("issues", issueOpenedPayload()));
    expect(res.status).toBe(200);

    const runs = await db.select().from(taskRun);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.jobName).toMatch(/^bandolier-agent-/);
    expect(run.repoFullName).toBe(REPO);
    expect(run.issueNumber).toBe("7");
    expect(run.displayName).toBe("#7: please fix the thing");
    // Owner = the Bandolier user linked to the triggering GitHub account.
    expect(run.spawnedBy).toBe(LINKED_USER);
    expect(run.agentImage).toBe(DEFAULT_HARNESS_IMAGE);
    expect(runUsesRepoCredentials).toHaveBeenCalledTimes(1);
  });

  it("does not run when the credential resolution yields nothing", async () => {
    resolveWebhookRun.mockResolvedValue(null);
    const res = await POST(webhookPost("issues", issueOpenedPayload()));
    expect(res.status).toBe(200);
    expect(await db.select().from(taskRun)).toHaveLength(0);
  });
});
