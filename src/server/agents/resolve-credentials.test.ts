import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AwsCredentials } from "~/server/agents/aws";
import type { db as Database } from "~/server/db";
import type { RepoCredentials } from "~/server/agents/webhook-config";

// Mock the credential getters the resolver composes, so we can drive every
// user/repo/prefer combination without a database. The per-kind fns keep test
// bodies simple; the module mocks assemble them into the getters' shapes.
const getUserAwsCredentials = vi.fn<() => Promise<AwsCredentials | null>>();
const getUserAnthropicKey = vi.fn<() => Promise<string | null>>();
const getUserAnthropicOauthToken = vi.fn<() => Promise<string | null>>();
const getUserOpenaiKey = vi.fn<() => Promise<string | null>>();
const getUserCodexAuthJson = vi.fn<() => Promise<string | null>>();
const getUserGeminiKey = vi.fn<() => Promise<string | null>>();
const getRepoCredentials = vi.fn<() => Promise<RepoCredentials | null>>();

vi.mock("~/server/agents/user-aws", () => ({
  getUserAwsCredentials: () => getUserAwsCredentials(),
}));
vi.mock("~/server/agents/anthropic", () => ({
  getUserAnthropicCredentials: async () => ({
    apiKey: await getUserAnthropicKey(),
    oauthToken: await getUserAnthropicOauthToken(),
  }),
}));
vi.mock("~/server/agents/openai", () => ({
  getUserOpenaiCredentials: async () => ({
    apiKey: await getUserOpenaiKey(),
    codexAuthJson: await getUserCodexAuthJson(),
  }),
}));
vi.mock("~/server/agents/gemini", () => ({
  getUserGeminiKey: () => getUserGeminiKey(),
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
    openaiApiKey: null,
    geminiApiKey: null,
    aws: null,
    preferRepoCredentials: false,
    ...overrides,
  };
}

beforeEach(() => {
  getUserAwsCredentials.mockReset().mockResolvedValue(null);
  getUserAnthropicKey.mockReset().mockResolvedValue(null);
  getUserAnthropicOauthToken.mockReset().mockResolvedValue(null);
  getUserOpenaiKey.mockReset().mockResolvedValue(null);
  getUserCodexAuthJson.mockReset().mockResolvedValue(null);
  getUserGeminiKey.mockReset().mockResolvedValue(null);
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

  it("surfaces the user's OpenAI key (user-scoped, no repo equivalent)", async () => {
    getUserOpenaiKey.mockResolvedValue("sk-openai");
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    expect(r.openaiApiKey).toBe("sk-openai");
    expect(r.aws).toBeNull();
    expect(r.anthropicApiKey).toBeNull();
  });

  it("keeps the user's OpenAI key available even when a repo set wins for Claude", async () => {
    getUserOpenaiKey.mockResolvedValue("sk-openai");
    getRepoCredentials.mockResolvedValue(
      repo({ anthropicApiKey: "sk-repo", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.anthropicApiKey).toBe("sk-repo");
    expect(r.openaiApiKey).toBe("sk-openai");
  });

  it("prefers the repo's OpenAI key over the user's when the repo set wins", async () => {
    getUserOpenaiKey.mockResolvedValue("sk-user-openai");
    getRepoCredentials.mockResolvedValue(
      repo({ openaiApiKey: "sk-repo-openai", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.openaiApiKey).toBe("sk-repo-openai");
  });

  it("uses the repo's OpenAI key for a user with no credentials of their own", async () => {
    getRepoCredentials.mockResolvedValue(
      repo({ openaiApiKey: "sk-repo-openai" }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.openaiApiKey).toBe("sk-repo-openai");
  });

  it("falls back to the user's Claude set when the repo set wins without a Claude provider", async () => {
    // Repo prefers its creds and has only a shared OpenAI key (no Claude side);
    // the user's own Anthropic key should still surface for Claude models.
    getUserAnthropicKey.mockResolvedValue("sk-user-anthropic");
    getRepoCredentials.mockResolvedValue(
      repo({ openaiApiKey: "sk-repo-openai", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.anthropicApiKey).toBe("sk-user-anthropic");
    expect(r.openaiApiKey).toBe("sk-repo-openai");
  });

  it("does NOT mix the repo's AWS with the user's Anthropic (Claude side is atomic)", async () => {
    // Repo has its own Claude provider (AWS), so the user's Anthropic must not
    // leak into the repo set even though Anthropic itself is otherwise empty.
    getUserAnthropicKey.mockResolvedValue("sk-user-anthropic");
    getRepoCredentials.mockResolvedValue(
      repo({ aws: repoAws, preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.aws).toBe(repoAws);
    expect(r.anthropicApiKey).toBeNull();
  });

  it("surfaces the user's Gemini key (independent provider)", async () => {
    getUserGeminiKey.mockResolvedValue("sk-gemini");
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    expect(r.geminiApiKey).toBe("sk-gemini");
  });

  it("prefers the repo's Gemini key over the user's when the repo set wins", async () => {
    getUserGeminiKey.mockResolvedValue("sk-user-gemini");
    getRepoCredentials.mockResolvedValue(
      repo({ geminiApiKey: "sk-repo-gemini", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.geminiApiKey).toBe("sk-repo-gemini");
  });

  it("surfaces the user's Claude subscription OAuth token", async () => {
    getUserAnthropicOauthToken.mockResolvedValue("sk-ant-oat01-x");
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    expect(r.anthropicOauthToken).toBe("sk-ant-oat01-x");
    expect(r.anthropicApiKey).toBeNull();
  });

  it("does NOT mix the repo's Anthropic key with the user's OAuth token (Claude side is atomic)", async () => {
    getUserAnthropicOauthToken.mockResolvedValue("sk-ant-oat01-x");
    getRepoCredentials.mockResolvedValue(
      repo({ anthropicApiKey: "sk-repo", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.anthropicApiKey).toBe("sk-repo");
    expect(r.anthropicOauthToken).toBeNull();
  });

  it("surfaces the user's ChatGPT auth.json when the repo has no OpenAI key", async () => {
    getUserCodexAuthJson.mockResolvedValue('{"tokens":{}}');
    getRepoCredentials.mockResolvedValue(
      repo({ anthropicApiKey: "sk-repo", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.codexAuthJson).toBe('{"tokens":{}}');
  });

  it("does NOT mix the repo's OpenAI key with the user's auth.json (OpenAI side is atomic)", async () => {
    getUserCodexAuthJson.mockResolvedValue('{"tokens":{}}');
    getRepoCredentials.mockResolvedValue(
      repo({ openaiApiKey: "sk-repo-openai", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.openaiApiKey).toBe("sk-repo-openai");
    expect(r.codexAuthJson).toBeNull();
  });

  it("ignores repo credentials entirely when no repo is given", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    const r = await resolveModelCredentials(db, "u1");
    expect(getRepoCredentials).not.toHaveBeenCalled();
    expect(r.source).toBe("user");
  });
});

describe("pickProvider", () => {
  // Base credential set with nothing configured; tests spread what they need.
  const empty = {
    aws: null,
    anthropicApiKey: null,
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
    source: "user" as const,
  };

  it("prefers AWS Bedrock over an Anthropic key", () => {
    const picked = pickProvider({
      ...empty,
      aws: repoAws,
      anthropicApiKey: "sk-both",
      openaiApiKey: "sk-openai",
      geminiApiKey: "sk-gemini",
      source: "repo",
    });
    expect(picked.aws).toBe(repoAws);
    expect(picked.anthropicApiKey).toBeNull();
    expect(picked.openaiApiKey).toBeNull();
    expect(picked.geminiApiKey).toBeNull();
  });

  it("falls back to the Anthropic key when there's no AWS", () => {
    const picked = pickProvider({
      ...empty,
      anthropicApiKey: "sk-only",
      openaiApiKey: "sk-openai",
      geminiApiKey: "sk-gemini",
    });
    expect(picked.aws).toBeNull();
    expect(picked.anthropicApiKey).toBe("sk-only");
    expect(picked.openaiApiKey).toBeNull();
    expect(picked.geminiApiKey).toBeNull();
  });

  it("treats a Claude subscription OAuth token as the Anthropic provider", () => {
    const picked = pickProvider({
      ...empty,
      anthropicOauthToken: "sk-ant-oat01-x",
      openaiApiKey: "sk-openai",
    });
    expect(picked.anthropicOauthToken).toBe("sk-ant-oat01-x");
    expect(picked.anthropicApiKey).toBeNull();
    expect(picked.openaiApiKey).toBeNull();
  });

  it("uses the OpenAI key over Gemini when no Claude provider is set", () => {
    const picked = pickProvider({
      ...empty,
      openaiApiKey: "sk-openai",
      geminiApiKey: "sk-gemini",
    });
    expect(picked.openaiApiKey).toBe("sk-openai");
    expect(picked.geminiApiKey).toBeNull();
  });

  it("treats a ChatGPT auth.json as the OpenAI provider", () => {
    const picked = pickProvider({
      ...empty,
      codexAuthJson: '{"tokens":{}}',
      geminiApiKey: "sk-gemini",
    });
    expect(picked.codexAuthJson).toBe('{"tokens":{}}');
    expect(picked.openaiApiKey).toBeNull();
    expect(picked.geminiApiKey).toBeNull();
  });

  it("uses the Gemini key only when no other provider is set", () => {
    const picked = pickProvider({
      ...empty,
      geminiApiKey: "sk-gemini",
    });
    expect(picked.aws).toBeNull();
    expect(picked.anthropicApiKey).toBeNull();
    expect(picked.openaiApiKey).toBeNull();
    expect(picked.geminiApiKey).toBe("sk-gemini");
  });
});
