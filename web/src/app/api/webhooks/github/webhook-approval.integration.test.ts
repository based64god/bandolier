import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GithubAppModule from "~/server/agents/github-app";
import type * as GithubIssuesModule from "~/server/agents/github-issues";
import type * as RepoPermsModule from "~/server/agents/repo-permissions";

// The maintainer-approval dispatch path, end-to-end against a real Postgres: a
// `/bando approve` comment from a maintainer atomically claims the held
// pending_agent_run (markResolved) and replays its stored spec through
// createAgentJob, which writes a real task_run. The DB claim + the recordRun
// insert run for real; only the collaborators that reach outside the process are
// stubbed — the bot token, the repo-permission lookup, the confirmation comment,
// and the whole k8s client (so the job/secret/PDB/namespace calls no-op).
const getRepoBotToken = vi
  .fn<() => Promise<string | null>>()
  .mockResolvedValue("bot-token");
vi.mock("~/server/agents/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubAppModule>()),
  getRepoBotToken: () => getRepoBotToken(),
}));

const getUserRepoPermission = vi
  .fn<() => Promise<string>>()
  .mockResolvedValue("maintain");
vi.mock("~/server/agents/repo-permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof RepoPermsModule>()),
  // Keep the real isMaintainerOrHigher — only the GitHub lookup is stubbed.
  getUserRepoPermission: () => getUserRepoPermission(),
}));

const postIssueCommentWithFallback = vi
  .fn<() => Promise<string | null>>()
  .mockResolvedValue("app-installation");
vi.mock("~/server/agents/github-issues", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubIssuesModule>()),
  postIssueCommentWithFallback: () => postIssueCommentWithFallback(),
}));

// The whole cluster client is faked so createAgentJob's namespace / SA / job /
// secret / PDB / network-policy calls no-op. createNamespacedJob returns a uid
// so the owner-reference wiring downstream has something to key on.
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
const { pendingAgentRun, taskRun } = await import("~/server/db/schema");
const { signWebhook } = await import("~/test/integration/auth-material");
const { db, resetDb } = await import("~/test/integration/harness");
const { seedPendingRun } = await import("~/test/integration/seed");

const SECRET = "test-webhook-secret"; // matches the integration env block
const REPO = "acme/widgets";
const LINKED_USER = "linked-user-42";

// A held run's stored spec: valid JobSpec credentials (kubeconfig + Anthropic key
// → the anthropic provider) so resolveProvider succeeds and createAgentJob runs
// end-to-end through the faked cluster to recordRun.
const HELD_SPEC = {
  task: "fix the flaky test",
  displayName: "#7: flaky test",
  namespace: "agents",
  branch: "main",
  model: "claude-sonnet-4-5",
  kubeconfig: "kc",
  anthropicApiKey: "sk-ant-held",
  userId: LINKED_USER,
  repoFullName: REPO,
  issueNumber: "7",
};

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

function approveComment(body: string) {
  return {
    action: "created",
    issue: {
      number: 7,
      title: "flaky test",
      body: "please fix",
      html_url: `https://github.com/${REPO}/issues/7`,
      labels: [] as { name: string }[],
    },
    comment: {
      id: 555,
      body,
      user: { id: 1, login: "maintainer", type: "User" },
    },
    repository: {
      full_name: REPO,
      clone_url: `https://github.com/${REPO}.git`,
      default_branch: "main",
    },
    sender: { id: 1, login: "maintainer" },
  };
}

describe("webhook /bando approve dispatch (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    getRepoBotToken.mockClear().mockResolvedValue("bot-token");
    getUserRepoPermission.mockClear().mockResolvedValue("maintain");
    postIssueCommentWithFallback
      .mockClear()
      .mockResolvedValue("app-installation");
  });

  it("resolves the held run and inserts a real task_run", async () => {
    const pending = await seedPendingRun({
      repoFullName: REPO,
      issueNumber: 7,
      requestedByLogin: "contributor",
      spec: HELD_SPEC,
    });

    const res = await POST(
      webhookPost("issue_comment", approveComment("/bando approve")),
    );
    expect(res.status).toBe(200);

    // The pending row was claimed one-shot: dispatched, stamped with the approver.
    const [row] = await db
      .select()
      .from(pendingAgentRun)
      .where(eq(pendingAgentRun.id, pending.id));
    expect(row!.resolvedAt).not.toBeNull();
    expect(row!.resolution).toBe("dispatched");
    expect(row!.resolvedByLogin).toBe("maintainer");

    // A real agent run landed, replaying the stored spec's fields.
    const runs = await db.select().from(taskRun);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.repoFullName).toBe(REPO);
    expect(runs[0]!.issueNumber).toBe("7");
    expect(runs[0]!.spawnedBy).toBe(LINKED_USER);
    expect(runs[0]!.displayName).toBe("#7: flaky test");
    expect(runs[0]!.agentImage).toBe(DEFAULT_HARNESS_IMAGE);
  });

  it("ignores an approval from a non-maintainer — the run stays held", async () => {
    getUserRepoPermission.mockResolvedValue("read");
    const pending = await seedPendingRun({
      repoFullName: REPO,
      issueNumber: 7,
      requestedByLogin: "contributor",
      spec: HELD_SPEC,
    });

    const res = await POST(
      webhookPost("issue_comment", approveComment("/bando approve")),
    );
    expect(res.status).toBe(200);

    // Not dispatched, and no run created.
    const [row] = await db
      .select()
      .from(pendingAgentRun)
      .where(eq(pendingAgentRun.id, pending.id));
    expect(row!.resolvedAt).toBeNull();
    expect(row!.resolution).toBeNull();
    expect(await db.select().from(taskRun)).toHaveLength(0);
  });
});
