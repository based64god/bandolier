import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GithubAppModule from "~/server/agents/github-app";
import type * as RepoPermsModule from "~/server/agents/repo-permissions";
import type { ResolvedWebhookRun } from "~/server/webhooks/resolve-run";

// The security-critical maintainer gate, end-to-end against a real Postgres: an
// issue that would run on the repo's SHARED credentials, opened by a
// non-maintainer, must be HELD — a real pending_agent_run row is written and NO
// task_run is created. The route does real HMAC verification and reads the real
// repo_webhook_config; only the credential-resolution collaborators
// (resolveWebhookRun, runUsesRepoCredentials, the bot token) are stubbed so the
// gate + storePendingRun run for real. This path is 100% mocked in the unit tests.
const resolveWebhookRun = vi.fn<() => Promise<ResolvedWebhookRun | null>>();
vi.mock("~/server/webhooks/resolve-run", () => ({
  resolveWebhookRun: (...a: unknown[]) => resolveWebhookRun(...(a as [])),
}));

const runUsesRepoCredentials = vi
  .fn<() => Promise<boolean>>()
  .mockResolvedValue(true);
vi.mock("~/server/agents/repo-permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof RepoPermsModule>()),
  runUsesRepoCredentials: (...a: unknown[]) =>
    runUsesRepoCredentials(...(a as [])),
}));

vi.mock("~/server/agents/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubAppModule>()),
  // No bot token → the gate can't verify privilege, so it fails closed (holds)
  // and skips posting the approval comment.
  getRepoBotToken: () => Promise.resolve(null),
}));

const { POST } = await import("~/app/api/webhooks/github/route");
const { repoWebhookConfig, pendingAgentRun, taskRun } = await import(
  "~/server/db/schema"
);
const { signWebhook } = await import("~/test/integration/auth-material");
const { db, resetDb } = await import("~/test/integration/harness");

const SECRET = "test-webhook-secret"; // matches the integration env block

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

const REPO = "acme/widgets";

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

describe("webhook credential-gate HOLD (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    resolveWebhookRun.mockReset().mockResolvedValue({
      linked: { userId: "owner-user", accessToken: null },
      model: "claude-sonnet-4-5",
      specBase: { model: "claude-sonnet-4-5", kubeconfig: "kc" },
      // `resolved` is consumed only by the (stubbed) runUsesRepoCredentials, so
      // its exact shape is irrelevant here.
      resolved: {} as ResolvedWebhookRun["resolved"],
    });
    runUsesRepoCredentials.mockReset().mockResolvedValue(true);
    // The repo opts into webhooks and prefers its shared credentials.
    await db.insert(repoWebhookConfig).values({
      repoFullName: REPO,
      triggerOnAllEvents: true,
      preferRepoCredentials: true,
    });
  });

  it("holds an under-privileged run: a pending row is written and no task_run", async () => {
    const res = await POST(webhookPost("issues", issueOpenedPayload()));
    expect(res.status).toBe(200);

    // A real pending_agent_run row captured the held run.
    const pending = await db
      .select()
      .from(pendingAgentRun)
      .where(eq(pendingAgentRun.repoFullName, REPO));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.issueNumber).toBe(7);
    expect(pending[0]!.requestedByLogin).toBe("contributor");
    expect(pending[0]!.resolvedAt).toBeNull(); // unresolved, awaiting approval
    // The serialized spec is stored for replay on approval.
    expect(pending[0]!.payload).toContain("claude-sonnet-4-5");

    // No agent was dispatched.
    const runs = await db.select().from(taskRun);
    expect(runs).toHaveLength(0);
    expect(runUsesRepoCredentials).toHaveBeenCalledTimes(1);
  });

  it("rejects a webhook with a bad signature (401), writing nothing", async () => {
    const raw = JSON.stringify(issueOpenedPayload());
    const req = new NextRequest("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: raw,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await db.select().from(pendingAgentRun)).toHaveLength(0);
  });
});
