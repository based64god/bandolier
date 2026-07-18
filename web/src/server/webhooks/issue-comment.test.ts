import { and, desc, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobSpec } from "~/server/agents/create-job";
import { taskRun } from "~/server/db/schema";
import type {
  PullRequestRefs,
  ThreadComment,
} from "~/server/agents/github-issues";
import { issuePreviewBranch } from "~/lib/issue-prompt";

import type {
  IssueCommentPayload,
  WebhookRunConfig,
} from "~/server/webhooks/types";

// handleIssueComment orchestrates the resume flow: it reads the parent run from
// the DB, resolves credentials, decides whether to continue the PR branch, and
// spawns a job. Mock every external boundary — the DB select chain, the
// credential resolver, the PR-refs fetch, the job spawner, and the bot-ack —
// and assert on the control-flow decisions and the spec handed to
// createAgentJob. The pure helpers (makeIssueBranch, the resume-prompt
// builders, git identity, namespace) stay real.

const createAgentJob = vi.fn<(spec: JobSpec) => Promise<string>>();
vi.mock("~/server/agents/create-job", () => ({
  createAgentJob: (spec: JobSpec) => createAgentJob(spec),
}));

const resolveWebhookRun = vi.fn<(opts: unknown) => Promise<unknown>>();
vi.mock("~/server/webhooks/resolve-run", () => ({
  resolveWebhookRun: (opts: unknown) => resolveWebhookRun(opts),
}));

const getPullRequestRefs =
  vi.fn<
    (token: string, repo: string, pr: number) => Promise<PullRequestRefs | null>
  >();
const listIssueComments =
  vi.fn<
    (token: string, repo: string, num: number) => Promise<ThreadComment[]>
  >();
const listReviewCommentThread =
  vi.fn<
    (
      token: string,
      repo: string,
      pr: number,
      rootId: number,
    ) => Promise<ThreadComment[]>
  >();
vi.mock("~/server/agents/github-issues", () => ({
  getPullRequestRefs: (token: string, repo: string, pr: number) =>
    getPullRequestRefs(token, repo, pr),
  listIssueComments: (token: string, repo: string, num: number) =>
    listIssueComments(token, repo, num),
  listReviewCommentThread: (
    token: string,
    repo: string,
    pr: number,
    rootId: number,
  ) => listReviewCommentThread(token, repo, pr, rootId),
}));

const getRegistryPullSecret =
  vi.fn<(image: string, token: string | null) => string | undefined>();
vi.mock("~/server/agents/github-app", () => ({
  getRegistryPullSecret: (image: string, token: string | null) =>
    getRegistryPullSecret(image, token),
}));

const postBotAck =
  vi.fn<(repo: string, num: number, body: string) => Promise<string | null>>();
vi.mock("~/server/webhooks/bot-ack", () => ({
  postBotAck: (repo: string, num: number, body: string) =>
    postBotAck(repo, num, body),
}));

// The parent-run lookup is a single drizzle select chain. This stub records the
// `where` predicate (so tests can assert PR-vs-issue matching) and resolves the
// configured rows; `select` is a spy so tests can assert it's never touched on
// the bot-loop / prefix short-circuits.
let parentRows: Record<string, unknown>[] = [];
const dbWhere = vi.fn(() => ({ orderBy }));
const orderBy = vi.fn(() => ({ limit }));
const limit = vi.fn(() => Promise.resolve(parentRows));
const dbFrom = vi.fn(() => ({ where: dbWhere }));
const dbSelect = vi.fn((_cols: unknown) => ({ from: dbFrom }));
vi.mock("~/server/db", () => ({
  db: { select: (cols: unknown) => dbSelect(cols) },
}));

const mockEnv = { BETTER_AUTH_URL: "http://test.local" };
vi.mock("~/env", () => ({ env: mockEnv }));

const { handleIssueComment } = await import("~/server/webhooks/issue-comment");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REPO = {
  full_name: "acme/widgets",
  clone_url: "https://github.com/acme/widgets.git",
  default_branch: "main",
};

function issuePayload(
  overrides: {
    pull_request?: { html_url: string };
    user?: { id: number; login: string; type?: string };
    body?: string | null;
    number?: number;
    title?: string;
  } = {},
): IssueCommentPayload {
  const number = overrides.number ?? 7;
  return {
    action: "created",
    issue: {
      number,
      title: overrides.title ?? "Fix the thing",
      body: "issue body",
      html_url: `https://github.com/acme/widgets/issues/${number}`,
      labels: [],
      pull_request: overrides.pull_request,
    },
    comment: {
      id: 1,
      body: overrides.body ?? "please continue",
      user: overrides.user ?? { id: 42, login: "octocat", type: "User" },
    },
    repository: REPO,
    sender: { id: 42, login: "octocat" },
  };
}

const CONFIG: WebhookRunConfig = {
  prefix: null,
  // Events never trigger by default, so the happy-path fixture opts into
  // firing on everything; the trigger-gate tests flip this off.
  triggerOnAllEvents: true,
  agentImage: null,
  defaultWebhookModel: null,
  reviewModel: null,
  defaultWebhookEffort: null,
  systemPrompt: null,
  networkPolicy: {
    allowPrivateEgress: false,
    allowAllPortsEgress: false,
    policyYaml: null,
  },
  // Resumes require a persisted parent transcript, so the happy-path fixture
  // has an artifact store; the gate tests flip this off.
  hasArtifactStore: true,
};

const RESOLVED = {
  linked: { userId: "u1", accessToken: "gh-token" },
  model: "claude-sonnet-4-5",
  specBase: { model: "claude-sonnet-4-5", kubeconfig: "kc" },
  resolved: {},
};

function refs(overrides: Partial<PullRequestRefs> = {}): PullRequestRefs {
  return {
    headRef: "acme:feature-branch",
    baseRef: "develop",
    headRepoFullName: "acme/widgets",
    state: "open",
    merged: false,
    title: "A PR",
    ...overrides,
  };
}

function jobSpec(): JobSpec {
  expect(createAgentJob).toHaveBeenCalledTimes(1);
  return createAgentJob.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  parentRows = [];
  resolveWebhookRun.mockResolvedValue(RESOLVED);
  createAgentJob.mockResolvedValue("job-abc");
  postBotAck.mockResolvedValue("app-installation");
  getPullRequestRefs.mockResolvedValue(refs());
  getRegistryPullSecret.mockReturnValue(undefined);
  listIssueComments.mockResolvedValue([]);
  listReviewCommentThread.mockResolvedValue([]);
});

// ── Bot-loop guard ───────────────────────────────────────────────────────────

describe("bot-loop guard", () => {
  it("returns before any DB read for a Bot-type commenter", async () => {
    await handleIssueComment(
      issuePayload({ user: { id: 99, login: "bandolier", type: "Bot" } }),
      CONFIG,
    );

    expect(dbSelect).not.toHaveBeenCalled();
    expect(resolveWebhookRun).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("returns before any DB read for a [bot]-suffixed login", async () => {
    await handleIssueComment(
      issuePayload({ user: { id: 99, login: "foo[bot]", type: "User" } }),
      CONFIG,
    );

    expect(dbSelect).not.toHaveBeenCalled();
    expect(resolveWebhookRun).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });
});

// ── Trigger gate ─────────────────────────────────────────────────────────────

describe("trigger gate", () => {
  it("skips when a configured prefix is absent from the comment", async () => {
    await handleIssueComment(issuePayload({ body: "just chatting" }), {
      ...CONFIG,
      triggerOnAllEvents: false,
      prefix: "/bando",
    });

    expect(dbSelect).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("proceeds when the configured prefix is present", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];

    await handleIssueComment(issuePayload({ body: "/bando please go" }), {
      ...CONFIG,
      triggerOnAllEvents: false,
      prefix: "/bando",
    });

    expect(dbSelect).toHaveBeenCalledTimes(1);
    expect(createAgentJob).toHaveBeenCalledTimes(1);
  });

  it("never triggers by default — no prefix, toggle off", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];

    await handleIssueComment(issuePayload({ body: "no prefix here" }), {
      ...CONFIG,
      triggerOnAllEvents: false,
    });

    expect(dbSelect).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("trigger-on-all-events acts on every comment, ignoring the prefix", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];

    await handleIssueComment(issuePayload({ body: "no prefix here" }), {
      ...CONFIG,
      prefix: "/bando",
    });

    expect(createAgentJob).toHaveBeenCalledTimes(1);
  });
});

// ── Artifact-store gate ──────────────────────────────────────────────────────

describe("artifact-store gate", () => {
  it("skips before any DB read when the repo has no artifact store", async () => {
    await handleIssueComment(issuePayload(), {
      ...CONFIG,
      hasArtifactStore: false,
    });

    expect(dbSelect).not.toHaveBeenCalled();
    expect(resolveWebhookRun).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips when the repo has no config row at all", async () => {
    await handleIssueComment(issuePayload(), null);

    expect(dbSelect).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });
});

// ── Parent matching ──────────────────────────────────────────────────────────

describe("parent matching", () => {
  it("skips when there is no run to resume", async () => {
    parentRows = [];

    await handleIssueComment(issuePayload(), CONFIG);

    expect(dbSelect).toHaveBeenCalledTimes(1);
    expect(resolveWebhookRun).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("matches an issue's parent by repo + issue number", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    expect(dbWhere).toHaveBeenCalledWith(
      and(
        eq(taskRun.repoFullName, "acme/widgets"),
        eq(taskRun.issueNumber, "7"),
        isNull(taskRun.reviewedPrUrl),
      ),
    );
    expect(orderBy).toHaveBeenCalledWith(desc(taskRun.createdAt));
  });

  it("matches a PR's parent by the pull-request URL", async () => {
    const prUrl = "https://github.com/acme/widgets/pull/7";
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: prUrl },
    ];

    await handleIssueComment(
      issuePayload({ pull_request: { html_url: prUrl } }),
      CONFIG,
    );

    expect(dbWhere).toHaveBeenCalledWith(
      and(
        eq(taskRun.repoFullName, "acme/widgets"),
        eq(taskRun.pullRequestUrl, prUrl),
        isNull(taskRun.reviewedPrUrl),
      ),
    );
  });
});

// ── PR-branch continuation ───────────────────────────────────────────────────

describe("PR-branch continuation", () => {
  const prUrl = "https://github.com/acme/widgets/pull/7";
  const asPrPayload = () =>
    issuePayload({ number: 7, pull_request: { html_url: prUrl } });

  beforeEach(() => {
    parentRows = [
      { jobName: "parent-1", displayName: "Parent", pullRequestUrl: prUrl },
    ];
  });

  it("resumes on the PR head branch when the PR is open and same-repo", async () => {
    getPullRequestRefs.mockResolvedValue(
      refs({ headRef: "acme:feature", baseRef: "develop" }),
    );

    await handleIssueComment(asPrPayload(), CONFIG);

    expect(getPullRequestRefs).toHaveBeenCalledWith(
      "gh-token",
      "acme/widgets",
      7,
    );
    const spec = jobSpec();
    expect(spec.resumeBranch).toBe("acme:feature");
    expect(spec.agentBranch).toBe("acme:feature");
    expect(spec.branch).toBe("acme:feature");
    expect(spec.baseBranch).toBe("develop");
  });

  it("starts a fresh branch when the PR is closed", async () => {
    getPullRequestRefs.mockResolvedValue(refs({ state: "closed" }));

    await handleIssueComment(asPrPayload(), CONFIG);

    const spec = jobSpec();
    expect(spec.resumeBranch).toBeUndefined();
    expect(spec.branch).toBe("main");
    expect(spec.baseBranch).toBe("main");
    // makeIssueBranch appends a random suffix to the stable preview slug.
    expect(spec.agentBranch).toMatch(
      new RegExp(`^${issuePreviewBranch(7, "Fix the thing")}-[a-z0-9]+$`),
    );
  });

  it("starts a fresh branch when the PR head is a fork", async () => {
    getPullRequestRefs.mockResolvedValue(
      refs({ headRepoFullName: "someone-else/widgets" }),
    );

    await handleIssueComment(asPrPayload(), CONFIG);

    const spec = jobSpec();
    expect(spec.resumeBranch).toBeUndefined();
    expect(spec.branch).toBe("main");
    expect(spec.baseBranch).toBe("main");
  });

  it("does not fetch PR refs when the sender has no access token", async () => {
    resolveWebhookRun.mockResolvedValue({
      ...RESOLVED,
      linked: { userId: "u1", accessToken: null },
    });

    await handleIssueComment(asPrPayload(), CONFIG);

    expect(getPullRequestRefs).not.toHaveBeenCalled();
    const spec = jobSpec();
    expect(spec.resumeBranch).toBeUndefined();
    expect(spec.branch).toBe("main");
  });
});

// ── Issue vs PR spec fields ──────────────────────────────────────────────────

describe("issue / PR spec fields", () => {
  it("sets issueNumber and issueUrl for an issue comment", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    const spec = jobSpec();
    expect(spec.issueNumber).toBe("7");
    expect(spec.issueUrl).toBe("https://github.com/acme/widgets/issues/7");
  });

  it("leaves issueNumber and issueUrl undefined for a PR comment", async () => {
    const prUrl = "https://github.com/acme/widgets/pull/7";
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: prUrl },
    ];

    await handleIssueComment(
      issuePayload({ number: 7, pull_request: { html_url: prUrl } }),
      CONFIG,
    );

    const spec = jobSpec();
    expect(spec.issueNumber).toBeUndefined();
    expect(spec.issueUrl).toBeUndefined();
  });

  it("resumes on a fresh branch for an issue whose parent opened no PR", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    // parent.pullRequestUrl is null → prNumberFromUrl → null → no refs fetch.
    expect(getPullRequestRefs).not.toHaveBeenCalled();
    const spec = jobSpec();
    expect(spec.resumeBranch).toBeUndefined();
    expect(spec.agentBranch).toMatch(
      new RegExp(`^${issuePreviewBranch(7, "Fix the thing")}-[a-z0-9]+$`),
    );
  });

  it("continues the PR branch that the parent issue run opened", async () => {
    parentRows = [
      {
        jobName: "parent-1",
        displayName: "d",
        pullRequestUrl: "https://github.com/acme/widgets/pull/12",
      },
    ];
    getPullRequestRefs.mockResolvedValue(refs({ headRef: "acme:issue-fix" }));

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    expect(getPullRequestRefs).toHaveBeenCalledWith(
      "gh-token",
      "acme/widgets",
      12,
    );
    const spec = jobSpec();
    expect(spec.resumeBranch).toBe("acme:issue-fix");
    // Still an issue comment, so the issue fields are set even on the PR branch.
    expect(spec.issueNumber).toBe("7");
  });
});

// ── Thread context ───────────────────────────────────────────────────────────

describe("thread context", () => {
  it("folds the earlier thread comments into the resume task, excluding the trigger", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];
    listIssueComments.mockResolvedValue([
      { id: 10, author: "alice", body: "first thought" },
      { id: 20, author: "bob", body: "second thought" },
      { id: 1, author: "octocat", body: "please continue" },
    ]);

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    expect(listIssueComments).toHaveBeenCalledWith(
      "gh-token",
      "acme/widgets",
      7,
    );
    const task = jobSpec().task;
    expect(task).toContain("Earlier comments in this thread");
    expect(task).toContain("@alice commented:");
    expect(task).toContain("first thought");
    expect(task).toContain("@bob commented:");
    // The triggering comment appears once, as the follow-up — not duplicated in
    // the earlier-thread block.
    expect(task.match(/please continue/g)).toHaveLength(1);
  });

  it("proceeds with just the trigger when the thread fetch fails", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];
    listIssueComments.mockRejectedValue(new Error("boom"));

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    const task = jobSpec().task;
    expect(task).not.toContain("Earlier comments in this thread");
    expect(task).toContain("please continue");
  });

  it("skips the thread fetch when the sender has no access token", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];
    resolveWebhookRun.mockResolvedValue({
      ...RESOLVED,
      linked: { userId: "u1", accessToken: null },
    });

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    expect(listIssueComments).not.toHaveBeenCalled();
    expect(createAgentJob).toHaveBeenCalledTimes(1);
  });
});

// ── Acknowledgement ──────────────────────────────────────────────────────────

describe("acknowledgement", () => {
  it("posts a bot-ack after spawning the resume job", async () => {
    parentRows = [
      { jobName: "parent-1", displayName: "d", pullRequestUrl: null },
    ];

    await handleIssueComment(issuePayload({ number: 7 }), CONFIG);

    expect(postBotAck).toHaveBeenCalledTimes(1);
    const [repo, num, body] = postBotAck.mock.calls[0]!;
    expect(repo).toBe("acme/widgets");
    expect(num).toBe(7);
    expect(body).toContain("job-abc");
    expect(body).toContain("parent-1");
  });
});
