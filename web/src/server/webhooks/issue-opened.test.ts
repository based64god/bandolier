import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobSpec } from "~/server/agents/create-job";
import type { ResolvedWebhookRun } from "~/server/webhooks/resolve-run";
import type { IssuePayload, WebhookRunConfig } from "~/server/webhooks/types";

// handleIssueOpened / handleIssueEdited compose many I/O boundaries (credential
// resolution, the repo-permission gate, the pending-run store, job dispatch).
// Mock every one so the two behaviours under test — the prefix-transition
// detection on an edit, and the fail-closed hold-for-approval path — can be
// driven purely by return values, with dispatch vs. hold observed at the mocked
// createAgentJob / storePendingRun boundary.

const resolveWebhookRun = vi.fn<() => Promise<ResolvedWebhookRun | null>>();
vi.mock("~/server/webhooks/resolve-run", () => ({
  resolveWebhookRun: () => resolveWebhookRun(),
}));

const createAgentJob = vi.fn<(spec: JobSpec) => Promise<string>>();
vi.mock("~/server/agents/create-job", () => ({
  createAgentJob: (spec: JobSpec) => createAgentJob(spec),
}));

const storePendingRun = vi.fn<() => Promise<string>>();
const setApprovalCommentId = vi.fn<() => Promise<void>>();
vi.mock("~/server/agents/agent-approval", () => ({
  storePendingRun: () => storePendingRun(),
  setApprovalCommentId: () => setApprovalCommentId(),
}));

const runUsesRepoCredentials = vi.fn<() => Promise<boolean>>();
const getUserRepoPermission = vi.fn<() => Promise<string>>();
const isMaintainerOrHigher = vi.fn<(p: string) => boolean>();
vi.mock("~/server/agents/repo-permissions", () => ({
  runUsesRepoCredentials: () => runUsesRepoCredentials(),
  getUserRepoPermission: () => getUserRepoPermission(),
  isMaintainerOrHigher: (p: string) => isMaintainerOrHigher(p),
}));

const getRepoBotToken = vi.fn<() => Promise<string | null>>();
const getRegistryPullSecret = vi.fn(() => undefined);
vi.mock("~/server/agents/github-app", () => ({
  getRepoBotToken: () => getRepoBotToken(),
  getRegistryPullSecret: () => getRegistryPullSecret(),
}));

const postIssueCommentReturningId = vi.fn<() => Promise<number>>();
vi.mock("~/server/agents/github-issues", () => ({
  postIssueCommentReturningId: () => postIssueCommentReturningId(),
}));

const postBotAck = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/webhooks/bot-ack", () => ({
  postBotAck: () => postBotAck(),
}));

vi.mock("~/server/db", () => ({ db: {} }));

const { handleIssueOpened, handleIssueEdited } =
  await import("~/server/webhooks/issue-opened");

// ── Fixtures ──────────────────────────────────────────────────────────────────

function payload(overrides: Partial<IssuePayload> = {}): IssuePayload {
  return {
    action: "edited",
    issue: {
      number: 7,
      title: "A title",
      body: "A body",
      html_url: "https://github.com/o/r/issues/7",
      labels: [],
    },
    repository: {
      full_name: "o/r",
      clone_url: "https://github.com/o/r.git",
      default_branch: "main",
    },
    sender: { id: 42, login: "octo" },
    ...overrides,
  };
}

function config(
  prefix: string | null,
  triggerOnAllEvents = false,
): WebhookRunConfig {
  return {
    prefix,
    triggerOnAllEvents,
    agentImage: null,
    defaultWebhookModel: null,
    defaultWebhookEffort: null,
    systemPrompt: null,
    networkPolicy: {
      allowPrivateEgress: false,
      allowAllPortsEgress: false,
      policyYaml: null,
    },
    // Opened issues spawn fresh runs, which don't need a persisted transcript
    // — false here pins that no artifact-store gate applies to them.
    hasArtifactStore: false,
  };
}

function resolvedRun(accessToken: string | null): ResolvedWebhookRun {
  return {
    linked: { userId: "u1", accessToken },
    model: "claude-sonnet-4-5",
    specBase: {
      model: "claude-sonnet-4-5",
      kubeconfig: "kc-yaml",
    },
    resolved: {} as ResolvedWebhookRun["resolved"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Default: resolution short-circuits, so "did handleIssueOpened proceed past
  // the prefix gate?" is observable as "was resolveWebhookRun called?".
  resolveWebhookRun.mockResolvedValue(null);
  isMaintainerOrHigher.mockImplementation(
    (p) => p === "maintain" || p === "admin",
  );
});

// ── handleIssueEdited: prefix-transition detection ─────────────────────────────

describe("handleIssueEdited", () => {
  const PREFIX = "/bando";

  it("runs when an edit adds the prefix to the body", async () => {
    await handleIssueEdited(
      payload({
        issue: {
          number: 7,
          title: "A title",
          body: "please /bando fix this",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
        changes: { body: { from: "please fix this" } },
      }),
      config(PREFIX),
    );
    expect(resolveWebhookRun).toHaveBeenCalledTimes(1);
  });

  it("runs when an edit adds the prefix to the title", async () => {
    await handleIssueEdited(
      payload({
        issue: {
          number: 7,
          title: "/bando do it",
          body: "A body",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
        changes: { title: { from: "do it" } },
      }),
      config(PREFIX),
    );
    expect(resolveWebhookRun).toHaveBeenCalledTimes(1);
  });

  it("skips when the changed field already contained the prefix before the edit", async () => {
    await handleIssueEdited(
      payload({
        issue: {
          number: 7,
          title: "A title",
          body: "/bando fix this now",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
        changes: { body: { from: "/bando fix this" } },
      }),
      config(PREFIX),
    );
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });

  it("skips when the edit never involves the prefix", async () => {
    await handleIssueEdited(
      payload({
        issue: {
          number: 7,
          title: "A title",
          body: "just some wording",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
        changes: { body: { from: "some wording" } },
      }),
      config(PREFIX),
    );
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });

  it("always skips when no prefix is configured", async () => {
    await handleIssueEdited(
      payload({
        issue: {
          number: 7,
          title: "/bando anything",
          body: "/bando anything",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
        changes: { body: { from: "nothing here" } },
      }),
      config(null),
    );
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });

  it("always skips under trigger-on-all-events — `opened` already fired on everything", async () => {
    await handleIssueEdited(
      payload({
        issue: {
          number: 7,
          title: "A title",
          body: "please /bando fix this",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
        changes: { body: { from: "please fix this" } },
      }),
      config(PREFIX, true),
    );
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });

  it("uses current field values as pre-edit text when `changes` is absent", async () => {
    // No `changes` at all: an unchanged title/body still holds the prefix, so it
    // must have been present before this edit — skip, don't re-run.
    await handleIssueEdited(
      payload({
        issue: {
          number: 7,
          title: "/bando already here",
          body: "A body",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
        changes: undefined,
      }),
      config(PREFIX),
    );
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });
});

// ── handleIssueOpened: hold-for-approval fail-closed path ──────────────────────

describe("handleIssueOpened repo-credentials gate", () => {
  it("holds for approval — no bot token and no access token means we can't verify, so fail closed", async () => {
    resolveWebhookRun.mockResolvedValue(resolvedRun(null));
    runUsesRepoCredentials.mockResolvedValue(true);
    getRepoBotToken.mockResolvedValue(null);
    storePendingRun.mockResolvedValue("pending-1");

    await handleIssueOpened(payload({ action: "opened" }), config(null, true));

    // No token to check permission with → permission is treated as "none" →
    // under-privileged → run is stored pending, never dispatched.
    expect(getUserRepoPermission).not.toHaveBeenCalled();
    expect(storePendingRun).toHaveBeenCalledTimes(1);
    expect(createAgentJob).not.toHaveBeenCalled();
    // No bot token, so no approval comment can be posted / recorded.
    expect(postIssueCommentReturningId).not.toHaveBeenCalled();
    expect(setApprovalCommentId).not.toHaveBeenCalled();
  });

  it("dispatches directly when the opener is a maintainer on repo credentials", async () => {
    resolveWebhookRun.mockResolvedValue(resolvedRun("user-token"));
    runUsesRepoCredentials.mockResolvedValue(true);
    getRepoBotToken.mockResolvedValue("bot-token");
    getUserRepoPermission.mockResolvedValue("admin");
    createAgentJob.mockResolvedValue("job-xyz");
    postBotAck.mockResolvedValue("app-installation");

    await handleIssueOpened(payload({ action: "opened" }), config(null, true));

    expect(createAgentJob).toHaveBeenCalledTimes(1);
    expect(storePendingRun).not.toHaveBeenCalled();
  });

  it("marks the run interactive when the issue carries an `interactive` label", async () => {
    resolveWebhookRun.mockResolvedValue(resolvedRun("user-token"));
    createAgentJob.mockResolvedValue("job-int");
    postBotAck.mockResolvedValue("app-installation");

    await handleIssueOpened(
      payload({
        action: "opened",
        issue: {
          number: 7,
          title: "A title",
          body: "A body",
          html_url: "https://github.com/o/r/issues/7",
          labels: [{ name: "interactive" }],
        },
      }),
      config(null, true),
    );

    expect(createAgentJob).toHaveBeenCalledTimes(1);
    expect(createAgentJob.mock.calls[0]![0].interactive).toBe(true);
  });

  it("leaves the run non-interactive without the label", async () => {
    resolveWebhookRun.mockResolvedValue(resolvedRun("user-token"));
    createAgentJob.mockResolvedValue("job-plain");
    postBotAck.mockResolvedValue("app-installation");

    await handleIssueOpened(payload({ action: "opened" }), config(null, true));

    expect(createAgentJob).toHaveBeenCalledTimes(1);
    expect(createAgentJob.mock.calls[0]![0].interactive).toBeUndefined();
  });
});

// ── handleIssueOpened trigger gate ─────────────────────────────────────────────

describe("handleIssueOpened trigger gate", () => {
  it("never triggers by default — no prefix, toggle off", async () => {
    await handleIssueOpened(payload({ action: "opened" }), config(null));
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });

  it("never triggers when the repo has no config row", async () => {
    await handleIssueOpened(payload({ action: "opened" }), null);
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });

  it("triggers when the issue text contains the prefix", async () => {
    await handleIssueOpened(
      payload({
        action: "opened",
        issue: {
          number: 7,
          title: "/bando do it",
          body: "A body",
          html_url: "https://github.com/o/r/issues/7",
          labels: [],
        },
      }),
      config("/bando"),
    );
    expect(resolveWebhookRun).toHaveBeenCalledTimes(1);
  });

  it("skips when the prefix is configured but absent from the issue", async () => {
    await handleIssueOpened(payload({ action: "opened" }), config("/bando"));
    expect(resolveWebhookRun).not.toHaveBeenCalled();
  });

  it("trigger-on-all-events fires without the prefix present", async () => {
    await handleIssueOpened(
      payload({ action: "opened" }),
      config("/bando", true),
    );
    expect(resolveWebhookRun).toHaveBeenCalledTimes(1);
  });
});
