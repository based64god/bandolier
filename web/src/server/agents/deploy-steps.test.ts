import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GithubIssue } from "~/server/agents/github-issues";
import type * as RepoPermissions from "~/server/agents/repo-permissions";
import type { db as Database } from "~/server/db";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";
import type {
  RepoNetworkPolicy,
  RepoWebhookConfig,
} from "~/server/agents/webhook-config";

// Mock the collaborators deploy-steps composes so we can drive every branch
// (privilege gate, issue lookup, repo config) without a database or network.
const runUsesRepoCredentials = vi.fn<() => Promise<boolean>>();
const getUserRepoPermission =
  vi.fn<() => Promise<RepoPermissions.RepoPermission>>();
const getIssue = vi.fn<() => Promise<GithubIssue | null>>();
const getRepoWebhookConfig = vi.fn<() => Promise<RepoWebhookConfig | null>>();
const getRegistryPullSecret =
  vi.fn<() => { registry: string; dockerConfigJson: string } | null>();

vi.mock("~/server/agents/repo-permissions", async (importOriginal) => ({
  // Keep the pure classifier (isMaintainerOrHigher) real; only the I/O-bound
  // helpers are stubbed.
  ...(await importOriginal<typeof RepoPermissions>()),
  runUsesRepoCredentials: () => runUsesRepoCredentials(),
  getUserRepoPermission: () => getUserRepoPermission(),
}));
vi.mock("~/server/agents/github-issues", () => ({
  getIssue: () => getIssue(),
}));
vi.mock("~/server/agents/webhook-config", () => ({
  getRepoWebhookConfig: () => getRepoWebhookConfig(),
}));
vi.mock("~/server/agents/github-app", () => ({
  getRegistryPullSecret: () => getRegistryPullSecret(),
}));

const { assertMayUseRepoCredentials, resolveIssueContext, loadRepoRunConfig } =
  await import("~/server/agents/deploy-steps");

const db = {} as unknown as typeof Database;

function creds(overrides: Partial<ModelCredentials> = {}): ModelCredentials {
  return {
    aws: null,
    anthropicApiKey: null,
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
    source: "none",
    ...overrides,
  };
}

function issue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    number: 7,
    title: "Fix the thing",
    url: "https://github.com/o/r/issues/7",
    body: "Details.",
    ...overrides,
  };
}

const noPolicy: RepoNetworkPolicy = {
  allowPrivateEgress: false,
  allowAllPortsEgress: false,
  policyYaml: null,
};

function repoConfig(
  overrides: Partial<RepoWebhookConfig> = {},
): RepoWebhookConfig {
  return {
    prefix: null,
    triggerOnAllEvents: false,
    agentImage: null,
    defaultWebhookModel: null,
    reviewModel: null,
    defaultWebhookEffort: null,
    systemPrompt: null,
    resumeOnCiFailure: false,
    reviewPullRequests: false,
    hasArtifactStore: false,
    networkPolicy: noPolicy,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertMayUseRepoCredentials", () => {
  it("is a no-op (no permission call) for a repo-less run", async () => {
    await expect(
      assertMayUseRepoCredentials(db, "u1", undefined, creds(), "tok", "alice"),
    ).resolves.toBeUndefined();
    expect(runUsesRepoCredentials).not.toHaveBeenCalled();
    expect(getUserRepoPermission).not.toHaveBeenCalled();
  });

  it("is a no-op when the run does not use repo credentials", async () => {
    runUsesRepoCredentials.mockResolvedValue(false);
    await expect(
      assertMayUseRepoCredentials(db, "u1", "o/r", creds(), "tok", "alice"),
    ).resolves.toBeUndefined();
    expect(getUserRepoPermission).not.toHaveBeenCalled();
  });

  it("fails closed with FORBIDDEN when there is no GitHub token", async () => {
    runUsesRepoCredentials.mockResolvedValue(true);
    await expect(
      assertMayUseRepoCredentials(db, "u1", "o/r", creds(), null, "alice"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getUserRepoPermission).not.toHaveBeenCalled();
  });

  it("fails closed with FORBIDDEN when there is no GitHub login", async () => {
    runUsesRepoCredentials.mockResolvedValue(true);
    await expect(
      assertMayUseRepoCredentials(db, "u1", "o/r", creds(), "tok", null),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getUserRepoPermission).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when the caller lacks maintainer access", async () => {
    runUsesRepoCredentials.mockResolvedValue(true);
    getUserRepoPermission.mockResolvedValue("write");
    await expect(
      assertMayUseRepoCredentials(db, "u1", "o/r", creds(), "tok", "alice"),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      assertMayUseRepoCredentials(db, "u1", "o/r", creds(), "tok", "alice"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("resolves when a maintainer uses the repo's shared credentials", async () => {
    runUsesRepoCredentials.mockResolvedValue(true);
    getUserRepoPermission.mockResolvedValue("maintain");
    await expect(
      assertMayUseRepoCredentials(db, "u1", "o/r", creds(), "tok", "alice"),
    ).resolves.toBeUndefined();
    expect(getUserRepoPermission).toHaveBeenCalledTimes(1);
  });
});

describe("resolveIssueContext", () => {
  it("uses the operator task and skips issue lookup with no issue number", async () => {
    const ctx = await resolveIssueContext(
      "tok",
      "o/r",
      undefined,
      "do it",
      false,
    );
    expect(getIssue).not.toHaveBeenCalled();
    expect(ctx.issue).toBeNull();
    expect(ctx.task).toBe("do it");
    expect(ctx.displayName).toBe("do it");
    expect(ctx.agentBranch).toBeUndefined();
    expect(ctx.systemPrompt).toBeUndefined();
  });

  it("truncates a long operator task for the display name", async () => {
    const task = "x".repeat(100);
    const ctx = await resolveIssueContext("tok", "o/r", undefined, task, false);
    expect(ctx.displayName).toBe(`${"x".repeat(60)}…`);
  });

  it("throws BAD_REQUEST when an issue number is given without a repo", async () => {
    await expect(
      resolveIssueContext("tok", undefined, 7, "do it", false),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("throws BAD_REQUEST when an issue number is given without a GitHub token", async () => {
    await expect(
      resolveIssueContext(null, "o/r", 7, "do it", false),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the issue does not exist", async () => {
    getIssue.mockResolvedValue(null);
    await expect(
      resolveIssueContext("tok", "o/r", 7, "do it", false),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("builds a branch and system prompt for a PR-output issue run", async () => {
    getIssue.mockResolvedValue(issue());
    const ctx = await resolveIssueContext("tok", "o/r", 7, "do it", false);
    expect(ctx.issue).toEqual(issue());
    expect(ctx.displayName).toBe("#7: Fix the thing");
    expect(ctx.agentBranch).toMatch(/^issue-7-fix-the-thing-[a-z0-9]{6}$/);
    expect(ctx.systemPrompt).toContain(ctx.agentBranch!);
    expect(ctx.task).toContain("## Issue #7: Fix the thing");
    expect(ctx.task).toContain("do it");
  });

  it("skips branch and system prompt for an issue-output run", async () => {
    getIssue.mockResolvedValue(issue());
    const ctx = await resolveIssueContext("tok", "o/r", 7, "do it", true);
    expect(ctx.issue).toEqual(issue());
    expect(ctx.agentBranch).toBeUndefined();
    expect(ctx.systemPrompt).toBeUndefined();
    expect(ctx.task).toContain("## Issue #7: Fix the thing");
  });
});

describe("loadRepoRunConfig", () => {
  it("returns an all-undefined config for a repo-less run", async () => {
    const config = await loadRepoRunConfig(db, undefined, "tok");
    expect(config).toEqual({
      agentImage: undefined,
      imagePullSecret: undefined,
      repoSystemPrompt: undefined,
      networkPolicy: undefined,
    });
    expect(getRepoWebhookConfig).not.toHaveBeenCalled();
  });

  it("maps the repo config fields through", async () => {
    getRepoWebhookConfig.mockResolvedValue(
      repoConfig({
        systemPrompt: "repo prompt",
        networkPolicy: { ...noPolicy, allowPrivateEgress: true },
      }),
    );
    const config = await loadRepoRunConfig(db, "o/r", "tok");
    expect(config.repoSystemPrompt).toBe("repo prompt");
    expect(config.networkPolicy).toEqual({
      ...noPolicy,
      allowPrivateEgress: true,
    });
    expect(config.agentImage).toBeUndefined();
    expect(config.imagePullSecret).toBeUndefined();
  });

  it("attaches a pull secret for a private ghcr.io image override", async () => {
    getRepoWebhookConfig.mockResolvedValue(
      repoConfig({ agentImage: "ghcr.io/o/harness:latest" }),
    );
    const secret = {
      registry: "ghcr.io",
      dockerConfigJson: "{}",
    };
    getRegistryPullSecret.mockReturnValue(secret);
    const config = await loadRepoRunConfig(db, "o/r", "tok");
    expect(config.agentImage).toBe("ghcr.io/o/harness:latest");
    expect(config.imagePullSecret).toBe(secret);
  });

  it("tolerates a config lookup failure without blocking the deploy", async () => {
    getRepoWebhookConfig.mockRejectedValue(new Error("db down"));
    const config = await loadRepoRunConfig(db, "o/r", "tok");
    expect(config).toEqual({
      agentImage: undefined,
      imagePullSecret: undefined,
      repoSystemPrompt: undefined,
      networkPolicy: undefined,
    });
  });
});
