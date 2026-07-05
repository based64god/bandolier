import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ResolveCredentials from "~/server/agents/resolve-credentials";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";

// Mock the I/O collaborators the deploy mutation composes along the path to the
// in-try maintainer gate, so a deliberate FORBIDDEN can be provoked without a
// database, Kubernetes, or GitHub. Everything downstream of the gate
// (createAgentJob et al.) is never reached, so it needs no mocking. The
// factories defer to top-level vi.fn()s through arrows to dodge hoisting TDZ.
const getUserGithubToken =
  vi.fn<() => Promise<string | null>>().mockResolvedValue("gh-tok");
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

const userHasRepoAccess = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
vi.mock("~/server/agents/github-repos", () => ({
  userHasRepoAccess: () => userHasRepoAccess(),
}));

vi.mock("~/server/agents/kubeconfig", () => ({
  resolveKubeconfig: () => Promise.resolve("kubeconfig"),
}));

vi.mock("~/server/agents/compute", () => ({
  resolveCompute: () => Promise.resolve({}),
  mergeCompute: (base: unknown) => base,
}));

const resolveModelCredentials = vi.fn<() => Promise<ModelCredentials>>();
vi.mock("~/server/agents/resolve-credentials", async (importOriginal) => ({
  // Keep the real registry-derived routing (providerForCredentials,
  // selectRunCredentials); only the I/O-bound resolver is stubbed.
  ...(await importOriginal<typeof ResolveCredentials>()),
  resolveModelCredentials: () => resolveModelCredentials(),
}));

const runUsesRepoCredentials =
  vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const getUserRepoPermission = vi.fn<() => Promise<string>>();
vi.mock("~/server/agents/repo-permissions", () => ({
  runUsesRepoCredentials: () => runUsesRepoCredentials(),
  getUserRepoPermission: () => getUserRepoPermission(),
  isMaintainerOrHigher: (p: string) => p === "maintain" || p === "admin",
}));

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
