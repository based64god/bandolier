import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AwsCredentials } from "~/server/agents/aws";
import type * as CustomProvidersModule from "~/server/agents/custom-providers";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";
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
type MockCustomProvider = { provider: string; apiKey?: string };
const getUserCustomProviders = vi.fn<() => Promise<MockCustomProvider[]>>();
const getRepoCustomProviders = vi.fn<() => Promise<MockCustomProvider[]>>();

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
vi.mock("~/server/agents/custom-providers", async (importOriginal) => ({
  // Keep the real mergeCustomProviders (pure); mock only the DB getters.
  ...(await importOriginal<typeof CustomProvidersModule>()),
  getUserCustomProviders: () => getUserCustomProviders(),
  getRepoCustomProviders: () => getRepoCustomProviders(),
}));

const {
  resolveModelCredentials,
  pickProvider,
  providerForCredentials,
  hasModelCredentials,
  selectRunCredentials,
  PROVIDERS,
} = await import("~/server/agents/resolve-credentials");

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
  getUserCustomProviders.mockReset().mockResolvedValue([]);
  getRepoCustomProviders.mockReset().mockResolvedValue([]);
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

  // ── gollm-proxied (custom) providers ──────────────────────────────────────

  it("surfaces the user's own custom providers (user set wins)", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    getUserCustomProviders.mockResolvedValue([{ provider: "groq" }]);
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    expect(r.customProviders?.map((c) => c.provider)).toEqual(["groq"]);
  });

  it("routes to the repo set when the user has nothing but the repo shares a custom provider", async () => {
    getRepoCustomProviders.mockResolvedValue([{ provider: "openrouter" }]);
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    expect(r.customProviders?.map((c) => c.provider)).toEqual(["openrouter"]);
  });

  it("merges repo and user custom providers in the repo set — repo wins per id", async () => {
    getUserCustomProviders.mockResolvedValue([
      { provider: "groq", apiKey: "user-groq" },
      { provider: "openrouter", apiKey: "user-or" },
    ]);
    getRepoCustomProviders.mockResolvedValue([
      { provider: "groq", apiKey: "repo-groq" },
      { provider: "together", apiKey: "repo-tg" },
    ]);
    // Repo prefers its creds so the repo set is returned.
    getRepoCredentials.mockResolvedValue(
      repo({ anthropicApiKey: "sk-repo", preferRepoCredentials: true }),
    );
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("repo");
    const byId = Object.fromEntries(
      (r.customProviders ?? []).map((c) => [c.provider, c.apiKey]),
    );
    // groq: repo wins; openrouter: user fills the gap; together: repo-only.
    expect(byId).toEqual({
      groq: "repo-groq",
      openrouter: "user-or",
      together: "repo-tg",
    });
  });

  it("merges the repo's shared custom providers into the winning user set (user wins per id)", async () => {
    getUserAnthropicKey.mockResolvedValue("sk-user");
    getUserCustomProviders.mockResolvedValue([
      { provider: "groq", apiKey: "user-groq" },
    ]);
    getRepoCustomProviders.mockResolvedValue([
      { provider: "groq", apiKey: "repo-groq" },
      { provider: "together", apiKey: "repo-tg" },
    ]);
    // Default preference → user set wins; its gollm providers win per id, but the
    // repo's shared ones (together) still fill the gaps so they stay available
    // (unlike the first-class credentials, which move as an all-or-nothing unit).
    const r = await resolveModelCredentials(db, "u1", "owner/repo");
    expect(r.source).toBe("user");
    const byId = Object.fromEntries(
      (r.customProviders ?? []).map((c) => [c.provider, c.apiKey]),
    );
    expect(byId).toEqual({ groq: "user-groq", together: "repo-tg" });
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

// The six credential fields, each paired with the provider it belongs to and a
// sample value, so the exhaustive tests below can build every present/absent
// combination and compare the registry against the (previously duplicated)
// provider-selection logic. Order here is independent of the registry's order.
const FIELDS = [
  { key: "aws", provider: "bedrock", value: repoAws },
  { key: "anthropicApiKey", provider: "anthropic", value: "sk-ant" },
  { key: "anthropicOauthToken", provider: "anthropic", value: "sk-ant-oat" },
  { key: "openaiApiKey", provider: "openai", value: "sk-openai" },
  { key: "codexAuthJson", provider: "openai", value: '{"tokens":{}}' },
  { key: "geminiApiKey", provider: "gemini", value: "sk-gemini" },
] as const;

/** Builds a ModelCredentials set from a bitmask over FIELDS. */
function credsFromMask(mask: number) {
  const set = {
    aws: null,
    anthropicApiKey: null,
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
    source: "user" as const,
  } as Record<string, unknown>;
  FIELDS.forEach((f, i) => {
    if (mask & (1 << i)) set[f.key] = f.value;
  });
  return set as unknown as ModelCredentials;
}

/** The provider create-job's flag cascade would route the set to (its old rule,
 * kept here as the reference the registry must agree with). */
function provider_ForCreateJobFlags(mask: number): string | null {
  const has = (key: string) =>
    FIELDS.some((f, i) => f.key === key && mask & (1 << i));
  if (has("aws")) return "bedrock";
  if (has("anthropicApiKey") || has("anthropicOauthToken")) return "anthropic";
  if (has("openaiApiKey") || has("codexAuthJson")) return "openai";
  if (has("geminiApiKey")) return "gemini";
  return null;
}

describe("provider registry", () => {
  it("orders providers by precedence: Bedrock > Anthropic > OpenAI > Gemini", () => {
    expect(PROVIDERS.map((p) => p.name)).toEqual([
      "bedrock",
      "anthropic",
      "openai",
      "gemini",
    ]);
  });

  it("providerForCredentials agrees with create-job's flag cascade for every credential combination", () => {
    for (let mask = 0; mask < 1 << FIELDS.length; mask++) {
      const creds = credsFromMask(mask);
      expect(providerForCredentials(creds)).toBe(
        provider_ForCreateJobFlags(mask),
      );
    }
  });

  it("hasModelCredentials is true iff a provider matches, for every combination", () => {
    for (let mask = 0; mask < 1 << FIELDS.length; mask++) {
      const creds = credsFromMask(mask);
      expect(hasModelCredentials(creds)).toBe(mask !== 0);
    }
  });

  it("pickProvider surfaces exactly the primary provider's fields for every combination", () => {
    for (let mask = 0; mask < 1 << FIELDS.length; mask++) {
      const creds = credsFromMask(mask);
      const provider = providerForCredentials(creds);
      const picked = pickProvider(creds);
      // Every non-null field on the picked set must belong to the primary
      // provider — no cross-provider leakage.
      for (const f of FIELDS) {
        const surfaced =
          (picked as unknown as Record<string, unknown>)[f.key] != null;
        expect(surfaced).toBe(
          f.provider === provider &&
            (creds as unknown as Record<string, unknown>)[f.key] != null,
        );
      }
    }
  });

  it("selectRunCredentials with no picker routes to the same provider as pickProvider", () => {
    for (let mask = 0; mask < 1 << FIELDS.length; mask++) {
      const creds = credsFromMask(mask);
      const run = selectRunCredentials(creds);
      expect(run.provider).toBe(providerForCredentials(creds));
    }
  });
});

describe("selectRunCredentials", () => {
  const set = {
    aws: null,
    anthropicApiKey: "sk-ant",
    anthropicOauthToken: "sk-ant-oat",
    openaiApiKey: "sk-openai",
    codexAuthJson: '{"tokens":{}}',
    geminiApiKey: "sk-gemini",
    source: "user" as const,
  };

  // A set with no first-class (Bedrock/Anthropic/OpenAI/Gemini) credentials, for
  // the gollm-routing and empty-provider paths below.
  const noFirstClass = {
    aws: null,
    anthropicApiKey: null,
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
    source: "user" as const,
  };

  // A full custom-provider credential; selectRunCredentials only reads `.provider`
  // to route, but returns the whole object as `customProvider`.
  const makeCustomProvider = (
    provider: string,
    apiKey: string | null = null,
  ): CustomProvidersModule.CustomProviderCredential => ({
    provider,
    apiKey,
    apiBase: null,
    extraEnv: null,
    models: null,
  });

  it("routes to the picked provider even when a higher-precedence one is set", () => {
    const run = selectRunCredentials(
      { ...set, aws: repoAws },
      { modelProvider: "openai" },
    );
    expect(run.provider).toBe("openai");
    expect(run.aws).toBeNull();
    expect(run.openaiApiKey).toBe("sk-openai");
  });

  it("pins to the API key when modelAuth is api_key (Anthropic)", () => {
    const run = selectRunCredentials(set, {
      modelProvider: "anthropic",
      modelAuth: "api_key",
    });
    expect(run.authKind).toBe("api_key");
    expect(run.anthropicApiKey).toBe("sk-ant");
    expect(run.anthropicOauthToken).toBeNull();
  });

  it("pins to the subscription when modelAuth is subscription (Anthropic)", () => {
    const run = selectRunCredentials(set, {
      modelProvider: "anthropic",
      modelAuth: "subscription",
    });
    expect(run.authKind).toBe("subscription");
    expect(run.anthropicApiKey).toBeNull();
    expect(run.anthropicOauthToken).toBe("sk-ant-oat");
  });

  it("lets the API key beat the subscription when modelAuth is unset (OpenAI)", () => {
    const run = selectRunCredentials(set, { modelProvider: "openai" });
    expect(run.authKind).toBe("api_key");
    expect(run.openaiApiKey).toBe("sk-openai");
    expect(run.codexAuthJson).toBeNull();
  });

  it("reports no auth kind for single-credential providers", () => {
    const run = selectRunCredentials(set, { modelProvider: "gemini" });
    expect(run.provider).toBe("gemini");
    expect(run.authKind).toBeNull();
    expect(run.geminiApiKey).toBe("sk-gemini");
  });

  it("returns a null provider and empty credentials for an empty set", () => {
    const run = selectRunCredentials({
      aws: null,
      anthropicApiKey: null,
      anthropicOauthToken: null,
      openaiApiKey: null,
      codexAuthJson: null,
      geminiApiKey: null,
      source: "none",
    });
    expect(run.provider).toBeNull();
    expect(run.authKind).toBeNull();
    expect(run.anthropicApiKey).toBeNull();
  });

  // ── gollm-proxied routing ──────────────────────────────────────────────────

  it("routes a picked gollm provider to its stored credential, leaving first-class fields empty", () => {
    const groq = makeCustomProvider("groq", "gsk-live");
    const run = selectRunCredentials(
      {
        ...noFirstClass,
        customProviders: [makeCustomProvider("openrouter"), groq],
      },
      { modelProvider: "gollm:groq" },
    );
    expect(run.provider).toBe("gollm:groq");
    expect(run.customProvider).toBe(groq);
    expect(run.authKind).toBeNull();
    // Exactly one provider's secrets reach the pod: the four first-class fields
    // stay null even though the set may carry others.
    expect(run.aws).toBeNull();
    expect(run.anthropicApiKey).toBeNull();
    expect(run.openaiApiKey).toBeNull();
    expect(run.geminiApiKey).toBeNull();
  });

  it("returns a null provider when the picked gollm provider is not in the set", () => {
    const run = selectRunCredentials(
      { ...noFirstClass, customProviders: [makeCustomProvider("groq")] },
      { modelProvider: "gollm:openrouter" },
    );
    expect(run.provider).toBeNull();
    expect(run.customProvider).toBeNull();
    expect(run.authKind).toBeNull();
  });

  it("falls back to the first gollm provider for a gollm-only set with no picker", () => {
    const groq = makeCustomProvider("groq", "gsk-live");
    const run = selectRunCredentials({
      ...noFirstClass,
      customProviders: [groq, makeCustomProvider("openrouter")],
    });
    expect(run.provider).toBe("gollm:groq");
    expect(run.customProvider).toBe(groq);
    expect(run.authKind).toBeNull();
    expect(run.anthropicApiKey).toBeNull();
  });

  it("returns a null provider for a malformed empty gollm provider id", () => {
    // parseGollmProvider("gollm:") yields "" (falsy), so this bypasses the early
    // gollm branch and falls into the fallback, where no credential matches the
    // empty id — the guard must return null, not leak a credential or throw.
    const run = selectRunCredentials(
      { ...noFirstClass, customProviders: [makeCustomProvider("groq")] },
      { modelProvider: "gollm:" },
    );
    expect(run.provider).toBeNull();
    expect(run.customProvider).toBeNull();
  });

  // ── picked provider with no matching credentials ───────────────────────────

  it("reports no auth kind when routed to Anthropic but the set has none", () => {
    // The picked provider wins even when the set holds no credentials for it;
    // the auth kind then lands on null (nothing to pin to).
    const run = selectRunCredentials(
      { ...noFirstClass, geminiApiKey: "sk-gemini" },
      { modelProvider: "anthropic" },
    );
    expect(run.provider).toBe("anthropic");
    expect(run.authKind).toBeNull();
    expect(run.anthropicApiKey).toBeNull();
    expect(run.anthropicOauthToken).toBeNull();
    // The gemini key present in the set must not leak into an Anthropic route.
    expect(run.geminiApiKey).toBeNull();
  });

  it("reports no auth kind when routed to OpenAI but the set has none", () => {
    const run = selectRunCredentials(
      { ...noFirstClass, geminiApiKey: "sk-gemini" },
      { modelProvider: "openai" },
    );
    expect(run.provider).toBe("openai");
    expect(run.authKind).toBeNull();
    expect(run.openaiApiKey).toBeNull();
    expect(run.codexAuthJson).toBeNull();
    expect(run.geminiApiKey).toBeNull();
  });
});
