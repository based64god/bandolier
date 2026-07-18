import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ResolveCredentials from "~/server/agents/resolve-credentials";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";

// Mock the I/O collaborators the deploy mutation composes along the path to the
// in-try maintainer gate, so a deliberate FORBIDDEN can be provoked without a
// database, Kubernetes, or GitHub. Everything downstream of the gate
// (createAgentJob et al.) is never reached, so it needs no mocking. The
// factories defer to top-level vi.fn()s through arrows to dodge hoisting TDZ.
const getUserGithubToken = vi
  .fn<() => Promise<string | null>>()
  .mockResolvedValue("gh-tok");
const getGithubIdentity = vi
  .fn<() => Promise<{ id: number; login: string }>>()
  .mockResolvedValue({ id: 1, login: "octocat" });
vi.mock("~/server/agents/github-token", () => ({
  getUserGithubToken: () => getUserGithubToken(),
  getGithubIdentity: () => getGithubIdentity(),
  githubGitIdentity: (id: string | number, login: string) => ({
    name: login,
    email: `${id}+${login}@users.noreply.github.com`,
  }),
}));

const userHasRepoAccess = vi
  .fn<() => Promise<boolean>>()
  .mockResolvedValue(true);
vi.mock("~/server/agents/github-repos", () => ({
  userHasRepoAccess: () => userHasRepoAccess(),
}));

vi.mock("~/server/agents/kubeconfig", () => ({
  resolveKubeconfig: () => Promise.resolve("kubeconfig"),
}));

const parseComputeInput = vi
  .fn<
    (
      cpu?: string,
      memory?: string,
    ) => { cpu: string | null; memory: string | null }
  >()
  .mockReturnValue({ cpu: null, memory: null });
vi.mock("~/server/agents/compute", () => ({
  resolveCompute: () => Promise.resolve({}),
  mergeCompute: (base: unknown) => base,
  parseComputeInput: (cpu?: string, memory?: string) =>
    parseComputeInput(cpu, memory),
}));

const resolveModelCredentials = vi.fn<() => Promise<ModelCredentials>>();
vi.mock("~/server/agents/resolve-credentials", async (importOriginal) => ({
  // Keep the real registry-derived routing (providerForCredentials,
  // selectRunCredentials); only the I/O-bound resolver is stubbed.
  ...(await importOriginal<typeof ResolveCredentials>()),
  resolveModelCredentials: () => resolveModelCredentials(),
}));

const runUsesRepoCredentials = vi
  .fn<() => Promise<boolean>>()
  .mockResolvedValue(true);
const getUserRepoPermission = vi.fn<() => Promise<string>>();
vi.mock("~/server/agents/repo-permissions", () => ({
  runUsesRepoCredentials: () => runUsesRepoCredentials(),
  getUserRepoPermission: () => getUserRepoPermission(),
  isMaintainerOrHigher: (p: string) => p === "maintain" || p === "admin",
}));

// retrigger reads the original Job back to recover the run's parameters; stub
// the batch client so it can be handed a canned Job (or none).
const listNamespacedJob = vi.fn<() => Promise<{ items: unknown[] }>>();
vi.mock("~/server/k8s/client", () => ({
  getBatchV1Api: () => ({ listNamespacedJob: () => listNamespacedJob() }),
  getCoreV1Api: () => ({}),
}));

function fakeJob(
  env: Record<string, string>,
  annotations: Record<string, string> = {},
  name = "bandolier-agent-1",
  limits?: { cpu?: string; memory?: string },
) {
  return {
    metadata: { name, annotations, labels: {} },
    spec: {
      template: {
        spec: {
          containers: [
            {
              env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
              ...(limits ? { resources: { limits } } : {}),
            },
          ],
        },
      },
    },
  };
}

const { agentsRouter } = await import("~/server/api/routers/agents");
const { createCallerFactory } = await import("~/server/api/trpc");

const createCaller = createCallerFactory(agentsRouter);

function caller() {
  return createCaller({
    db: {} as never,
    headers: new Headers(),
    session: {
      session: {
        id: "s1",
        userId: "u1",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      user: { id: "u1", name: "Ada", email: "ada@x.com" },
    },
  } as never);
}

function creds(overrides: Partial<ModelCredentials> = {}): ModelCredentials {
  return {
    aws: null,
    anthropicApiKey: "sk-ant",
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
    source: "repo",
    ...overrides,
  };
}

beforeEach(() => {
  getUserGithubToken.mockReset().mockResolvedValue("gh-tok");
  getGithubIdentity.mockReset().mockResolvedValue({ id: 1, login: "octocat" });
  userHasRepoAccess.mockReset().mockResolvedValue(true);
  resolveModelCredentials.mockReset().mockResolvedValue(creds());
  runUsesRepoCredentials.mockReset().mockResolvedValue(true);
  getUserRepoPermission.mockReset().mockResolvedValue("read");
  parseComputeInput.mockReset().mockReturnValue({ cpu: null, memory: null });
  listNamespacedJob.mockReset().mockResolvedValue({ items: [] });
});

describe("agents.deploy error propagation", () => {
  it("surfaces a FORBIDDEN thrown inside the try block with its original code", async () => {
    // A non-maintainer whose run would spend the repo's shared credentials is
    // rejected inside the try block. The catch must rethrow the TRPCError as-is,
    // not re-wrap it as INTERNAL_SERVER_ERROR (which would 500 at the REST
    // layer instead of 403).
    const err = await caller()
      .deploy({
        namespace: "ns",
        task: "do the thing",
        model: "claude-opus-4-8",
        repoFullName: "owner/repo",
      })
      .then(
        () => {
          throw new Error("expected deploy to reject");
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect((err as TRPCError).message).toContain("maintainer access or higher");
  });
});

describe("agents.deploy review validation", () => {
  it("rejects a review with a PR number but no repository", async () => {
    const err = await caller()
      .deploy({
        namespace: "ns",
        task: "",
        model: "claude-opus-4-8",
        outputType: "review",
        reviewPrNumber: 5,
      })
      .then(
        () => {
          throw new Error("expected deploy to reject");
        },
        (e: unknown) => e,
      );
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toContain("pull request number");
  });

  it("rejects a review with neither a PR number nor a task (input refine)", async () => {
    const err = await caller()
      .deploy({
        namespace: "ns",
        task: "",
        model: "claude-opus-4-8",
        repoFullName: "owner/repo",
        outputType: "review",
      })
      .then(
        () => {
          throw new Error("expected deploy to reject");
        },
        (e: unknown) => e,
      );
    // Zod refine rejects before the handler runs.
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
  });
});

describe("agents.retrigger", () => {
  it("404s when the original job is no longer present", async () => {
    listNamespacedJob.mockResolvedValue({ items: [] });
    const err = await caller()
      .retrigger({ namespace: "ns", jobName: "gone" })
      .then(
        () => {
          throw new Error("expected retrigger to reject");
        },
        (e: unknown) => e,
      );
    expect((err as TRPCError).code).toBe("NOT_FOUND");
    expect((err as TRPCError).message).toContain("cleaned up");
  });

  it("rejects when the job carries no model to replay", async () => {
    listNamespacedJob.mockResolvedValue({
      items: [fakeJob({ CLAUDE_TASK: "do it" })],
    });
    const err = await caller()
      .retrigger({ namespace: "ns", jobName: "bandolier-agent-1" })
      .then(
        () => {
          throw new Error("expected retrigger to reject");
        },
        (e: unknown) => e,
      );
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toContain("model");
  });

  it("recovers the review parameters from the job's env and replays them", async () => {
    // A review job with no repository recorded: the recovered outputType/PR
    // number carry into `deploy`, which then rejects the missing repo — proving
    // the review params (not the pre-expanded CLAUDE_TASK) were threaded back.
    listNamespacedJob.mockResolvedValue({
      items: [
        fakeJob({
          CLAUDE_MODEL: "claude-opus-4-8",
          CLAUDE_TASK: "already-expanded review context",
          OUTPUT_TYPE: "review",
          REVIEW_PR_NUMBER: "7",
        }),
      ],
    });
    const err = await caller()
      .retrigger({ namespace: "ns", jobName: "bandolier-agent-1" })
      .then(
        () => {
          throw new Error("expected retrigger to reject");
        },
        (e: unknown) => e,
      );
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toContain("review");
  });

  it("replays the original run's CPU/memory limits for compute parity", async () => {
    // The pod spec's limits are the compute the run actually used; retrigger
    // pins them so the re-run lands on the same box instead of re-deriving from
    // the (possibly since changed) repo/user defaults.
    listNamespacedJob.mockResolvedValue({
      items: [
        fakeJob(
          {
            CLAUDE_MODEL: "claude-opus-4-8",
            CLAUDE_TASK: "do the thing",
          },
          {},
          "bandolier-agent-1",
          { cpu: "4", memory: "8Gi" },
        ),
      ],
    });
    await caller()
      .retrigger({ namespace: "ns", jobName: "bandolier-agent-1" })
      .catch(() => undefined);
    expect(parseComputeInput).toHaveBeenCalledWith("4", "8Gi");
  });

  it("pins the re-run to the provider the original run resolved to", async () => {
    // Only an Anthropic key is configured, but the original ran on Gemini
    // (recorded as an annotation). Threading that provider back into deploy
    // routes credential selection to Gemini — which has none — so deploy fails
    // with the no-credentials error, proving the provider (not the current
    // primary) drove the re-run.
    resolveModelCredentials.mockResolvedValue(creds());
    listNamespacedJob.mockResolvedValue({
      items: [
        fakeJob(
          { CLAUDE_MODEL: "gemini-2.5-pro", CLAUDE_TASK: "do it" },
          { "bandolier.io/model-provider": "gemini" },
        ),
      ],
    });
    const err = await caller()
      .retrigger({ namespace: "ns", jobName: "bandolier-agent-1" })
      .then(
        () => {
          throw new Error("expected retrigger to reject");
        },
        (e: unknown) => e,
      );
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toContain("No model credentials");
  });

  it("pins the re-run to the auth kind the original run resolved to", async () => {
    // Only an Anthropic API key is configured, but the original ran on the
    // subscription kind. Threading that auth kind back excludes the API key and
    // finds no subscription token, so deploy fails with the no-credentials
    // error — proving the auth kind (not the api-key-beats-subscription
    // precedence) drove the re-run.
    resolveModelCredentials.mockResolvedValue(creds());
    listNamespacedJob.mockResolvedValue({
      items: [
        fakeJob(
          { CLAUDE_MODEL: "claude-opus-4-8", CLAUDE_TASK: "do it" },
          {
            "bandolier.io/model-provider": "anthropic",
            "bandolier.io/model-auth": "subscription",
          },
        ),
      ],
    });
    const err = await caller()
      .retrigger({ namespace: "ns", jobName: "bandolier-agent-1" })
      .then(
        () => {
          throw new Error("expected retrigger to reject");
        },
        (e: unknown) => e,
      );
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toContain("No model credentials");
  });
});
