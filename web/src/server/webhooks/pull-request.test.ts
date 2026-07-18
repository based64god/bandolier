import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobSpec } from "~/server/agents/create-job";
import type { ResolvedWebhookRun } from "~/server/webhooks/resolve-run";
import type {
  PullRequestPayload,
  WebhookRunConfig,
} from "~/server/webhooks/types";

// handlePullRequestOpened / handlePullRequestSynchronize drive automatic PR
// reviews. Mock every boundary — credential resolution, the parent-review DB
// lookup, and job dispatch — so the behaviours under test (draft skip, the
// review spec, and the re-review resume gates) are driven by return values and
// observed at the mocked createAgentJob.

const resolveWebhookRun =
  vi.fn<
    (opts: {
      defaultModel: string | null;
    }) => Promise<ResolvedWebhookRun | null>
  >();
vi.mock("~/server/webhooks/resolve-run", () => ({
  resolveWebhookRun: (opts: { defaultModel: string | null }) =>
    resolveWebhookRun(opts),
}));

const createAgentJob = vi.fn<(spec: JobSpec) => Promise<string>>();
vi.mock("~/server/agents/create-job", () => ({
  createAgentJob: (spec: JobSpec) => createAgentJob(spec),
}));

const getRegistryPullSecret = vi.fn(() => undefined);
const getRepoBotToken = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/github-app", () => ({
  getRegistryPullSecret: () => getRegistryPullSecret(),
  getRepoBotToken: () => getRepoBotToken(),
}));

// The base-only-update check compares the PR's diff at the before/after heads
// via the compare API; each ghFetch resolves the next queued compare response.
const ghFetch = vi.fn<() => Promise<{ json: () => Promise<unknown> }>>();
vi.mock("~/server/agents/github-api", () => ({
  ghFetch: () => ghFetch(),
}));

function compareResponse(
  files: { filename: string; status: string; patch?: string }[],
) {
  return { json: () => Promise.resolve({ files }) };
}

// The parent-review lookup is a single drizzle select chain; this stub resolves
// the configured rows so the synchronize handler can be driven by them.
let parentRows: Record<string, unknown>[] = [];
const limit = vi.fn(() => Promise.resolve(parentRows));
const orderBy = vi.fn(() => ({ limit }));
const dbWhere = vi.fn(() => ({ orderBy }));
const dbFrom = vi.fn(() => ({ where: dbWhere }));
const dbSelect = vi.fn(() => ({ from: dbFrom }));
vi.mock("~/server/db", () => ({ db: { select: () => dbSelect() } }));

const { handlePullRequestOpened, handlePullRequestSynchronize } =
  await import("~/server/webhooks/pull-request");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO = {
  full_name: "acme/widgets",
  clone_url: "https://github.com/acme/widgets.git",
  default_branch: "main",
};

function payload(
  overrides: {
    action?: string;
    number?: number;
    title?: string;
    body?: string | null;
    draft?: boolean;
    before?: string;
    after?: string;
  } = {},
): PullRequestPayload {
  const number = overrides.number ?? 7;
  return {
    action: overrides.action ?? "opened",
    number,
    pull_request: {
      number,
      title: overrides.title ?? "Add a feature",
      body: overrides.body ?? "PR body",
      html_url: `https://github.com/acme/widgets/pull/${number}`,
      labels: [],
      draft: overrides.draft,
      user: { id: 42, login: "octo" },
      base: { ref: "main" },
    },
    repository: REPO,
    before: overrides.before,
    after: overrides.after,
    sender: { id: 42, login: "octo" },
  };
}

function config(overrides: Partial<WebhookRunConfig> = {}): WebhookRunConfig {
  return {
    prefix: null,
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
    ...overrides,
  };
}

function resolvedRun(
  accessToken: string | null = "gh-tok",
): ResolvedWebhookRun {
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
  parentRows = [];
  resolveWebhookRun.mockResolvedValue(resolvedRun());
  createAgentJob.mockResolvedValue("bandolier-agent-1");
  getRepoBotToken.mockResolvedValue("bot-tok");
});

describe("handlePullRequestOpened", () => {
  it("dispatches a read-only review run for an opened PR", async () => {
    await handlePullRequestOpened(payload(), config());

    expect(createAgentJob).toHaveBeenCalledTimes(1);
    const spec = createAgentJob.mock.calls[0]![0];
    expect(spec.outputType).toBe("review");
    expect(spec.reviewPrNumber).toBe("7");
    expect(spec.reviewedPrUrl).toBe("https://github.com/acme/widgets/pull/7");
    expect(spec.displayName).toBe("Review #7: Add a feature");
    // Read-only: no working branch, no server-supplied framing, no PR lineage.
    expect(spec.agentBranch).toBeUndefined();
    expect(spec.systemPrompt).toBeUndefined();
    expect(spec.parentJobName).toBeUndefined();
    // The PR context is the task.
    expect(spec.task).toContain("Pull request #7");
  });

  it("prefers the repo's reviewModel over the webhook model", async () => {
    await handlePullRequestOpened(
      payload(),
      config({ reviewModel: "claude-opus-4-8", defaultWebhookModel: "sonnet" }),
    );
    expect(resolveWebhookRun).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: "claude-opus-4-8" }),
    );
  });

  it("falls back to the webhook model when no reviewModel is set", async () => {
    await handlePullRequestOpened(
      payload(),
      config({ reviewModel: null, defaultWebhookModel: "sonnet" }),
    );
    expect(resolveWebhookRun).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: "sonnet" }),
    );
  });

  it("skips a draft PR (waits for ready_for_review)", async () => {
    await handlePullRequestOpened(payload({ draft: true }), config());
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips when the sender isn't a Bandolier user with credentials", async () => {
    resolveWebhookRun.mockResolvedValue(null);
    await handlePullRequestOpened(payload(), config());
    expect(createAgentJob).not.toHaveBeenCalled();
  });
});

describe("handlePullRequestSynchronize", () => {
  it("resumes the PR's most recent review run for a re-review", async () => {
    parentRows = [
      { jobName: "review-1", displayName: "Review #7: Add a feature" },
    ];

    await handlePullRequestSynchronize(
      payload({ action: "synchronize" }),
      config(),
    );

    expect(createAgentJob).toHaveBeenCalledTimes(1);
    const spec = createAgentJob.mock.calls[0]![0];
    expect(spec.outputType).toBe("review");
    expect(spec.parentJobName).toBe("review-1");
    expect(spec.displayName).toBe("Re-review #7: Add a feature");
    expect(spec.reviewedPrUrl).toBe("https://github.com/acme/widgets/pull/7");
    expect(spec.task).toContain("was updated");
  });

  it("skips when there's no prior review to resume", async () => {
    parentRows = [];
    await handlePullRequestSynchronize(
      payload({ action: "synchronize" }),
      config(),
    );
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("skips when the repo has no artifact store (no transcript to resume)", async () => {
    parentRows = [{ jobName: "review-1", displayName: "d" }];
    await handlePullRequestSynchronize(
      payload({ action: "synchronize" }),
      config({ hasArtifactStore: false }),
    );
    expect(createAgentJob).not.toHaveBeenCalled();
    // Gated before the parent lookup even runs.
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("skips a base-only update (rebase/merge leaves the PR diff unchanged)", async () => {
    parentRows = [{ jobName: "review-1", displayName: "Review #7" }];
    // Same contribution signature at both heads ⇒ no new work.
    const files = [
      { filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ];
    ghFetch
      .mockResolvedValueOnce(compareResponse(files))
      .mockResolvedValueOnce(compareResponse(files));

    await handlePullRequestSynchronize(
      payload({ action: "synchronize", before: "sha-old", after: "sha-new" }),
      config(),
    );

    expect(ghFetch).toHaveBeenCalledTimes(2);
    expect(createAgentJob).not.toHaveBeenCalled();
  });

  it("re-reviews when the head diff changed (new commits added)", async () => {
    parentRows = [{ jobName: "review-1", displayName: "Review #7" }];
    ghFetch
      .mockResolvedValueOnce(
        compareResponse([
          {
            filename: "a.ts",
            status: "modified",
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
        ]),
      )
      .mockResolvedValueOnce(
        compareResponse([
          {
            filename: "a.ts",
            status: "modified",
            patch: "@@ -1 +2 @@\n-a\n+b\n+c",
          },
        ]),
      );

    await handlePullRequestSynchronize(
      payload({ action: "synchronize", before: "sha-old", after: "sha-new" }),
      config(),
    );

    expect(createAgentJob).toHaveBeenCalledTimes(1);
    expect(createAgentJob.mock.calls[0]![0].parentJobName).toBe("review-1");
  });

  it("fails open (re-reviews) when the compare can't be read", async () => {
    parentRows = [{ jobName: "review-1", displayName: "Review #7" }];
    getRepoBotToken.mockResolvedValue(null);

    await handlePullRequestSynchronize(
      payload({ action: "synchronize", before: "sha-old", after: "sha-new" }),
      config(),
    );

    expect(ghFetch).not.toHaveBeenCalled();
    expect(createAgentJob).toHaveBeenCalledTimes(1);
  });
});
