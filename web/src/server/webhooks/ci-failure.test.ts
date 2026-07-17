import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WebhookRunConfig, WorkflowRunPayload } from "./types";

// handleCiFailure is the only thing standing between a failing CI pipeline and
// an infinite resume→push→fail→resume loop that spends the run owner's
// credentials. Its guards — the lineage resume cap, the head-SHA de-dupe, the
// open/same-repo (fork) gate, and the conclusion filter — are exercised here by
// mocking every boundary the handler touches (the database, the webhook-run
// resolver, the PR refs fetch, and createAgentJob) and asserting which events
// dispatch a run and which are skipped.

// ── Database mock ─────────────────────────────────────────────────────────────
//
// The handler runs three distinct selects against `taskRun`, distinguished by
// the columns in their WHERE clause:
//   - the parent lookup           → filters on `pull_request_url`
//   - the head-SHA de-dupe        → filters on `ci_resume_sha`
//   - the lineage walk            → filters on `job_name` alone
// `routeQuery` walks the real drizzle expression to read those filter values and
// returns rows from the test-configured `dbState`, so the query builder chain
// (`.from().where().orderBy().limit()`) resolves like the real one.

interface LineageRow {
  parentJobName: string | null;
  ciResumeSha: string | null;
}
interface ParentRow {
  jobName: string;
  displayName: string | null;
  spawnedBy: string | null;
  createdBy: string | null;
}

const dbState: {
  parent: ParentRow | undefined;
  dedupe: Record<string, { jobName: string }>;
  lineage: Map<string, LineageRow>;
} = { parent: undefined, dedupe: {}, lineage: new Map() };

/** Walks a drizzle WHERE expression into an ordered list of column→value pairs. */
function whereFilters(pred: unknown): Record<string, string> {
  const seq: { kind: "col" | "val"; value: string }[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (
      typeof n.name === "string" &&
      !("queryChunks" in n) &&
      !("value" in n)
    ) {
      seq.push({ kind: "col", value: n.name });
    }
    if (
      (node as { constructor?: { name?: string } }).constructor?.name ===
        "Param" &&
      "value" in n
    ) {
      seq.push({ kind: "val", value: String(n.value) });
    }
    const chunks = n.queryChunks;
    if (Array.isArray(chunks)) chunks.forEach(visit);
  };
  visit(pred);
  const byCol: Record<string, string> = {};
  for (let i = 0; i < seq.length; i++) {
    if (seq[i]!.kind === "col" && seq[i + 1]?.kind === "val") {
      byCol[seq[i]!.value] = seq[i + 1]!.value;
    }
  }
  return byCol;
}

function routeQuery(pred: unknown): unknown[] {
  const f = whereFilters(pred);
  if ("pull_request_url" in f) return dbState.parent ? [dbState.parent] : [];
  if ("ci_resume_sha" in f) {
    const row = dbState.dedupe[f.ci_resume_sha];
    return row ? [row] : [];
  }
  if ("job_name" in f) {
    const row = dbState.lineage.get(f.job_name);
    return row ? [row] : [];
  }
  throw new Error(`unexpected query filter: ${JSON.stringify(f)}`);
}

const dbSelect = vi.fn((_cols: unknown) => {
  let where: unknown;
  const builder = {
    from: () => builder,
    where: (pred: unknown) => {
      where = pred;
      return builder;
    },
    orderBy: () => builder,
    limit: () => builder,
    then: (
      resolve: (rows: unknown[]) => unknown,
      reject: (e: unknown) => unknown,
    ) =>
      Promise.resolve()
        .then(() => routeQuery(where))
        .then(resolve, reject),
  };
  return builder;
});

vi.mock("~/server/db", () => ({
  db: { select: (cols: unknown) => dbSelect(cols) },
}));

// ── Other boundaries ──────────────────────────────────────────────────────────

const getGithubAccountByUserId =
  vi.fn<
    (
      db: unknown,
      userId: string,
    ) => Promise<{ githubId: string; accessToken: string | null } | null>
  >();
vi.mock("~/server/agents/github-token", () => ({
  getGithubAccountByUserId: (db: unknown, userId: string) =>
    getGithubAccountByUserId(db, userId),
  // Pure identity builder — mirror the real implementation.
  githubGitIdentity: (id: string | number, login: string) => ({
    name: login,
    email: `${id}+${login}@users.noreply.github.com`,
  }),
}));

const getPullRequestRefs = vi.fn<() => Promise<unknown>>();
vi.mock("~/server/agents/github-issues", () => ({
  getPullRequestRefs: () => getPullRequestRefs(),
}));

const resolveWebhookRun = vi.fn<() => Promise<unknown>>();
vi.mock("./resolve-run", () => ({
  resolveWebhookRun: () => resolveWebhookRun(),
}));

const createAgentJob = vi.fn<(spec: unknown) => Promise<string>>();
vi.mock("~/server/agents/create-job", () => ({
  createAgentJob: (spec: unknown) => createAgentJob(spec),
}));

const postBotAck =
  vi.fn<(repo: string, pr: number, body: string) => Promise<string | null>>();
vi.mock("./bot-ack", () => ({
  postBotAck: (repo: string, pr: number, body: string) =>
    postBotAck(repo, pr, body),
}));

const getRegistryPullSecret = vi.fn(() => undefined);
vi.mock("~/server/agents/github-app", () => ({
  getRegistryPullSecret: () => getRegistryPullSecret(),
}));

vi.mock("~/server/agents/namespace", () => ({
  repoToNamespace: (repo: string) => `ns-${repo}`,
}));

vi.mock("~/lib/issue-prompt", () => ({
  buildCiResumeUserMessage: () => "resume-message",
  buildResumeSystemPrompt: () => "resume-system-prompt",
}));

vi.mock("~/env", () => ({ env: { BETTER_AUTH_URL: "http://test.local" } }));

const { handleCiFailure, countCiResumesInLineage } =
  await import("./ci-failure");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HEAD_SHA = "sha-fail";

function payload(
  over: Partial<WorkflowRunPayload["workflow_run"]> = {},
): WorkflowRunPayload {
  return {
    action: "completed",
    workflow_run: {
      name: "CI",
      head_branch: "feature",
      head_sha: HEAD_SHA,
      conclusion: "failure",
      html_url: "http://gh/run/1",
      pull_requests: [{ number: 7 }],
      ...over,
    },
    repository: {
      full_name: "o/r",
      clone_url: "https://github.com/o/r.git",
      default_branch: "main",
    },
  };
}

const CONFIG: WebhookRunConfig = {
  prefix: null,
  // CI-failure resumes are gated by resumeOnCiFailure, not the trigger gate —
  // false here pins that the trigger toggle plays no part in this handler.
  triggerOnAllEvents: false,
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
  hasArtifactStore: true,
};

const OPEN_SAME_REPO_REFS = {
  headRef: "feature",
  baseRef: "main",
  headRepoFullName: "o/r",
  state: "open" as const,
  merged: false,
  title: "My PR",
};

/** Wire up the boundaries so a single failing pipeline resumes cleanly. */
function primeHappyPath() {
  dbState.parent = {
    jobName: "parent-job",
    displayName: "Parent run",
    spawnedBy: "u1",
    createdBy: "octocat",
  };
  getGithubAccountByUserId.mockResolvedValue({
    githubId: "12345",
    accessToken: "gh-tok",
  });
  resolveWebhookRun.mockResolvedValue({
    linked: { userId: "u1", accessToken: "gh-tok" },
    model: "claude-x",
    specBase: { model: "claude-x", kubeconfig: "kc", anthropicApiKey: "sk-a" },
    resolved: {},
  });
  getPullRequestRefs.mockResolvedValue(OPEN_SAME_REPO_REFS);
  createAgentJob.mockResolvedValue("bandolier-agent-999");
  postBotAck.mockResolvedValue("bando-bot");
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.parent = undefined;
  dbState.dedupe = {};
  dbState.lineage = new Map();
});

// ── countCiResumesInLineage ────────────────────────────────────────────────────

describe("countCiResumesInLineage", () => {
  it("counts each ancestor that carries a ciResumeSha along the parent chain", async () => {
    dbState.lineage = new Map<string, LineageRow>([
      ["j3", { parentJobName: "j2", ciResumeSha: "s3" }],
      ["j2", { parentJobName: "j1", ciResumeSha: "s2" }],
      ["j1", { parentJobName: "root", ciResumeSha: "s1" }],
      ["root", { parentJobName: null, ciResumeSha: null }],
    ]);
    expect(await countCiResumesInLineage("j3")).toBe(3);
  });

  it("does not count ancestors with no ciResumeSha (human/initial runs)", async () => {
    dbState.lineage = new Map<string, LineageRow>([
      ["j2", { parentJobName: "j1", ciResumeSha: "s2" }],
      ["j1", { parentJobName: "root", ciResumeSha: null }],
      ["root", { parentJobName: null, ciResumeSha: null }],
    ]);
    expect(await countCiResumesInLineage("j2")).toBe(1);
  });

  it("returns 0 when the run does not exist", async () => {
    expect(await countCiResumesInLineage("missing")).toBe(0);
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });

  it("terminates on a corrupt parent cycle (A→B→A) instead of spinning", async () => {
    dbState.lineage = new Map<string, LineageRow>([
      ["A", { parentJobName: "B", ciResumeSha: "sa" }],
      ["B", { parentJobName: "A", ciResumeSha: "sb" }],
    ]);
    // The walk is bounded at MAX_CI_RESUMES + 5 = 8 iterations, so it returns a
    // finite count and issues a bounded number of queries rather than hanging.
    const count = await countCiResumesInLineage("A");
    expect(count).toBe(8);
    expect(dbSelect).toHaveBeenCalledTimes(8);
  });
});

// ── handleCiFailure: conclusion filter ──────────────────────────────────────────

describe("handleCiFailure conclusion filter", () => {
  it("returns early for a non-failure conclusion without touching the database", async () => {
    await handleCiFailure(payload({ conclusion: "success" }), CONFIG);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips when the failing pipeline has no associated pull request", async () => {
    await handleCiFailure(payload({ pull_requests: [] }), CONFIG);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });
});

// ── handleCiFailure: parent / de-dupe / cap guards ──────────────────────────────

describe("handleCiFailure artifact-store gate", () => {
  it("skips before any DB read when the repo has no artifact store", async () => {
    primeHappyPath();
    await handleCiFailure(payload(), { ...CONFIG, hasArtifactStore: false });
    expect(dbSelect).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips when the repo has no config row at all", async () => {
    primeHappyPath();
    await handleCiFailure(payload(), null);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });
});

describe("handleCiFailure resume guards", () => {
  it("skips when no prior Bandolier run produced the PR", async () => {
    dbState.parent = undefined;
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("does not resume twice for the same failing commit (head-SHA de-dupe)", async () => {
    primeHappyPath();
    dbState.dedupe[HEAD_SHA] = { jobName: "already-resumed" };
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).not.toHaveBeenCalled();
    // Skipped before consulting the PR refs or the webhook resolver.
    expect(resolveWebhookRun).not.toHaveBeenCalled();
    expect(getPullRequestRefs).not.toHaveBeenCalled();
  });

  it("stops resuming once the lineage hits MAX_CI_RESUMES (3 prior CI resumes)", async () => {
    primeHappyPath();
    dbState.lineage = new Map<string, LineageRow>([
      ["parent-job", { parentJobName: "r2", ciResumeSha: "s1" }],
      ["r2", { parentJobName: "r1", ciResumeSha: "s2" }],
      ["r1", { parentJobName: "root", ciResumeSha: "s3" }],
      ["root", { parentJobName: null, ciResumeSha: null }],
    ]);
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("still resumes when the lineage has fewer than MAX_CI_RESUMES prior resumes", async () => {
    primeHappyPath();
    dbState.lineage = new Map<string, LineageRow>([
      ["parent-job", { parentJobName: "r1", ciResumeSha: "s1" }],
      ["r1", { parentJobName: "root", ciResumeSha: "s2" }],
      ["root", { parentJobName: null, ciResumeSha: null }],
    ]);
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).toHaveBeenCalledTimes(1);
    expect(createAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({ ciResumeSha: HEAD_SHA }),
    );
  });
});

// ── handleCiFailure: open / same-repo (fork) gate ───────────────────────────────

describe("handleCiFailure PR-continuable gate", () => {
  it("skips a closed PR — its branch is no longer the place to push a fix", async () => {
    primeHappyPath();
    getPullRequestRefs.mockResolvedValue({
      ...OPEN_SAME_REPO_REFS,
      state: "closed",
    });
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips a fork PR — a fork's head branch can't be pushed to", async () => {
    primeHappyPath();
    getPullRequestRefs.mockResolvedValue({
      ...OPEN_SAME_REPO_REFS,
      headRepoFullName: "fork/r",
    });
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips when the PR refs can't be read", async () => {
    primeHappyPath();
    getPullRequestRefs.mockResolvedValue(null);
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).not.toHaveBeenCalled();
  });
});

// ── handleCiFailure: happy path ─────────────────────────────────────────────────

describe("handleCiFailure dispatch", () => {
  it("resumes an open same-repo PR as the parent owner, tagging the failing SHA", async () => {
    primeHappyPath();
    await handleCiFailure(payload(), CONFIG);

    expect(getGithubAccountByUserId).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
    );
    expect(createAgentJob).toHaveBeenCalledTimes(1);
    expect(createAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        ciResumeSha: HEAD_SHA,
        parentJobName: "parent-job",
        parentDisplayName: "Parent run",
        agentBranch: "feature",
        baseBranch: "main",
        resumeBranch: "feature",
        repoFullName: "o/r",
        namespace: "ns-o/r",
        createdBy: "octocat",
      }),
    );
    // The resume is acknowledged on the PR in the bot voice.
    expect(postBotAck).toHaveBeenCalledWith("o/r", 7, expect.any(String));
  });

  it("skips when the parent run has no owner to resume as", async () => {
    primeHappyPath();
    dbState.parent = {
      jobName: "parent-job",
      displayName: "Parent run",
      spawnedBy: null,
      createdBy: "octocat",
    };
    await handleCiFailure(payload(), CONFIG);
    expect(getGithubAccountByUserId).not.toHaveBeenCalled();
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips when the owner has no linked GitHub account", async () => {
    primeHappyPath();
    getGithubAccountByUserId.mockResolvedValue(null);
    await handleCiFailure(payload(), CONFIG);
    expect(createAgentJob).not.toHaveBeenCalled();
  });
});
