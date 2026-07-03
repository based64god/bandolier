import { beforeEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";
import type { RepoCredentials } from "~/server/agents/webhook-config";

// Mock the collaborators runUsesRepoCredentials composes so we can drive every
// repo/user/prefer combination without a database.
const getRepoCredentials = vi.fn<() => Promise<RepoCredentials | null>>();
const resolveModelCredentials = vi.fn<() => Promise<ModelCredentials>>();
const getUserKubeconfig = vi.fn<() => Promise<string | null>>();

vi.mock("~/server/agents/webhook-config", () => ({
  getRepoCredentials: () => getRepoCredentials(),
}));
vi.mock("~/server/agents/resolve-credentials", () => ({
  resolveModelCredentials: () => resolveModelCredentials(),
}));
vi.mock("~/server/agents/kubeconfig", () => ({
  getUserKubeconfig: () => getUserKubeconfig(),
}));

const { runUsesRepoCredentials } =
  await import("~/server/agents/repo-permissions");

const db = {} as unknown as typeof Database;

function repo(overrides: Partial<RepoCredentials>): RepoCredentials {
  return {
    kubeconfig: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    geminiApiKey: null,
    aws: null,
    preferRepoCredentials: false,
    ...overrides,
  };
}

function creds(overrides: Partial<ModelCredentials>): ModelCredentials {
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

beforeEach(() => {
  vi.clearAllMocks();
  getUserKubeconfig.mockResolvedValue(null);
});

describe("runUsesRepoCredentials", () => {
  it("is false when the repo has no config row at all", async () => {
    getRepoCredentials.mockResolvedValue(null);
    expect(await runUsesRepoCredentials(db, "u1", "o/r")).toBe(false);
  });

  it("is true when the resolved model credentials come from the repo", async () => {
    getRepoCredentials.mockResolvedValue(repo({ anthropicApiKey: "repo-key" }));
    const resolved = creds({ anthropicApiKey: "repo-key", source: "repo" });
    expect(await runUsesRepoCredentials(db, "u1", "o/r", resolved)).toBe(true);
  });

  it("is false when the resolved model credentials come from the user", async () => {
    getRepoCredentials.mockResolvedValue(repo({ anthropicApiKey: "repo-key" }));
    const resolved = creds({ anthropicApiKey: "user-key", source: "user" });
    expect(await runUsesRepoCredentials(db, "u1", "o/r", resolved)).toBe(false);
  });

  it("is true when only the repo supplies a kubeconfig (user has none)", async () => {
    getRepoCredentials.mockResolvedValue(repo({ kubeconfig: "repo-kc" }));
    getUserKubeconfig.mockResolvedValue(null);
    const resolved = creds({ source: "none" });
    expect(await runUsesRepoCredentials(db, "u1", "o/r", resolved)).toBe(true);
  });

  it("is false when the user has their own kubeconfig and the repo isn't preferred", async () => {
    getRepoCredentials.mockResolvedValue(repo({ kubeconfig: "repo-kc" }));
    getUserKubeconfig.mockResolvedValue("user-kc");
    const resolved = creds({ source: "none" });
    expect(await runUsesRepoCredentials(db, "u1", "o/r", resolved)).toBe(false);
  });

  it("is true when the repo's kubeconfig is preferred even though the user has one", async () => {
    getRepoCredentials.mockResolvedValue(
      repo({ kubeconfig: "repo-kc", preferRepoCredentials: true }),
    );
    getUserKubeconfig.mockResolvedValue("user-kc");
    const resolved = creds({ source: "none" });
    expect(await runUsesRepoCredentials(db, "u1", "o/r", resolved)).toBe(true);
  });

  it("resolves credentials itself when none are passed", async () => {
    getRepoCredentials.mockResolvedValue(repo({ anthropicApiKey: "repo-key" }));
    resolveModelCredentials.mockResolvedValue(
      creds({ anthropicApiKey: "repo-key", source: "repo" }),
    );
    expect(await runUsesRepoCredentials(db, "u1", "o/r")).toBe(true);
    expect(resolveModelCredentials).toHaveBeenCalledTimes(1);
  });
});
