import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AwsCredentials } from "~/server/agents/aws";
import type { db as Database } from "~/server/db";
import type { RepoCredentials } from "~/server/agents/webhook-config";

// Mock the three credential getters the resolver composes, so we can drive every
// user/repo/prefer combination without a database.
const getUserAwsCredentials = vi.fn<() => Promise<AwsCredentials | null>>();
const getUserAnthropicKey = vi.fn<() => Promise<string | null>>();
const getRepoCredentials = vi.fn<() => Promise<RepoCredentials | null>>();

vi.mock("~/server/agents/user-aws", () => ({
  getUserAwsCredentials: () => getUserAwsCredentials(),
}));
vi.mock("~/server/agents/anthropic", () => ({
  getUserAnthropicKey: () => getUserAnthropicKey(),
}));
vi.mock("~/server/agents/webhook-config", () => ({
  getRepoCredentials: () => getRepoCredentials(),
}));

const { resolveModelCredentials, pickProvider } =
  await import("~/server/agents/resolve-credentials");

// The resolver only forwards `db` to the (mocked) getters, so a stub suffices.
const db = {} as unknown as typeof Database;

const userAws: AwsCredentials = {
  accessKeyId: "AKIAUSER",
  secretAccessKey: "user-secret",
  sessionToken: null,
  region: "us-east-1",
};
const repoAws: AwsCredentials = {
  accessKeyId: "AKIAREPO",
  secretAccessKey: "repo-secret",
  sessionToken: null,
  region: "eu-west-1",
};

function repo(overrides: Partial<RepoCredentials>): RepoCredentials {
  return {
    kubeconfig: null,
    anthropicApiKey: null,
    aws: null,
    preferRepoCredentials: false,
    ...overrides,
  };
}

beforeEach(() => {
  getUserAwsCredentials.mockReset().mockResolvedValue(null);
  getUserAnthropicKey.mockReset().mockResolvedValue(null);
  getRepoCredentials.mockReset().mockResolvedValue(null);
});

describe("resolveModelCredentials", () => {
  it("returns none when nothing is configured", async () => {
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("none");
    expect(r.aws).toBeNull();
    expect(r.anthropicApiKey).toBeNull();
  });

  it("uses the user's own credentials when the repo has none", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    expect(r.anthropicApiKey).toBe("sk-user");
  });

  it("prefers user credentials over repo credentials by default", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    getRepoCredentials.mockResolvedValue(repo({ anthropicApiKey: "sk-repo" }));
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    expect(r.anthropicApiKey).toBe("sk-user");
  });

  it("prefers repo credentials when the flag is set", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    getRepoCredentials.mockResolvedValue(
      repo({ anthropicApiKey: "sk-repo", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.anthropicApiKey).toBe("sk-repo");
  });

  it("falls back to the user's set when the repo prefers its own but has none", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    getRepoCredentials.mockResolvedValue(repo({ preferRepoCredentials: true }));
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    expect(r.anthropicApiKey).toBe("sk-user");
  });

  it("falls back to the repo's set when the user has none (default preference)", async () => {
    getRepoCredentials.mockResolvedValue(repo({ anthropicApiKey: "sk-repo" }));
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.anthropicApiKey).toBe("sk-repo");
  });

  it("never mixes the user's AWS with the repo's Anthropic — the chosen set wins whole", async () => {
    getUserAwsCredentials.mockResolvedValue(userAws);
    getRepoCredentials.mockResolvedValue(
      repo({ anthropicApiKey: "sk-repo", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    // Repo preferred and has creds, so the whole repo set wins: no user AWS.
    expect(r.source).toBe("repo");
    expect(r.aws).toBeNull();
    expect(r.anthropicApiKey).toBe("sk-repo");
  });

  it("ignores repo credentials entirely when no repo is given", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    const r = await resolveModelCredentials(db, "u1");
    expect(getRepoCredentials).not.toHaveBeenCalled();
    expect(r.source).toBe("user");
  });
});

describe("pickProvider", () => {
  it("prefers AWS Bedrock over an Anthropic key", () => {
    const picked = pickProvider({
      aws: repoAws,
      anthropicApiKey: "sk-both",
      source: "repo",
    });
    expect(picked.aws).toBe(repoAws);
    expect(picked.anthropicApiKey).toBeNull();
  });

  it("falls back to the Anthropic key when there's no AWS", () => {
    const picked = pickProvider({
      aws: null,
      anthropicApiKey: "sk-only",
      source: "user",
    });
    expect(picked.aws).toBeNull();
    expect(picked.anthropicApiKey).toBe("sk-only");
  });
});
