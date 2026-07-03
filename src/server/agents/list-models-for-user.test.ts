import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AwsCredentials } from "~/server/agents/aws";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";
import type { db as Database } from "~/server/db";

// Covers listModelsForUser — the orchestrator that resolves credentials and
// fans out to per-provider model fetchers. The pure pickers/error-mapping live
// in models.test.ts; this file mocks the external boundaries (credential
// resolution, the OpenAI/Gemini list modules, the Bedrock SDK client, and the
// global fetch used for the Anthropic REST API) to drive the routing,
// precedence, and failure-aggregation branches hermetically.

const resolveModelCredentials =
  vi.fn<
    (
      database: unknown,
      userId: string,
      repoFullName?: string,
    ) => Promise<ModelCredentials>
  >();
const fetchOpenaiModels =
  vi.fn<(apiKey: string) => Promise<{ id: string; label: string }[]>>();
const fetchGeminiModels =
  vi.fn<(apiKey: string) => Promise<{ id: string; label: string }[]>>();

vi.mock("~/server/agents/resolve-credentials", () => ({
  resolveModelCredentials: (
    database: unknown,
    userId: string,
    repoFullName?: string,
  ) => resolveModelCredentials(database, userId, repoFullName),
}));
vi.mock("~/server/agents/openai", () => ({
  listOpenaiModels: (apiKey: string) => fetchOpenaiModels(apiKey),
}));
vi.mock("~/server/agents/gemini", () => ({
  listGeminiModels: (apiKey: string) => fetchGeminiModels(apiKey),
}));

// Fake Bedrock SDK: commands carry their input and keep their class names, the
// client delegates to spies so tests can assert what was sent, when destroy()
// ran, and what config the client was constructed with.
interface FakeCommand {
  input: Record<string, unknown>;
}
const bedrockSend =
  vi.fn<(command: FakeCommand) => Promise<Record<string, unknown>>>();
const bedrockDestroy = vi.fn();
const bedrockClientConfigs: {
  region?: string;
  credentials?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  maxAttempts?: number;
}[] = [];

vi.mock("@aws-sdk/client-bedrock", () => {
  class ListInferenceProfilesCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class ListFoundationModelsCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class BedrockClient {
    constructor(config: (typeof bedrockClientConfigs)[number]) {
      bedrockClientConfigs.push(config);
    }
    send(command: FakeCommand) {
      return bedrockSend(command);
    }
    destroy() {
      bedrockDestroy();
    }
  }
  return {
    BedrockClient,
    ListInferenceProfilesCommand,
    ListFoundationModelsCommand,
  };
});

const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
vi.stubGlobal("fetch", fetchMock);

const { listModelsForUser } = await import("~/server/agents/models");

// listModelsForUser only forwards `db` to (mocked) resolution, so a stub works.
const db = {} as unknown as typeof Database;

function creds(overrides: Partial<ModelCredentials>): ModelCredentials {
  return {
    aws: null,
    anthropicApiKey: null,
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
    source: "user",
    ...overrides,
  };
}

const aws: AwsCredentials = {
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "test-secret",
  sessionToken: null,
  region: "us-east-1",
};

/** A minimal Response-shaped object for the mocked global fetch. */
function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resolveModelCredentials.mockReset();
  fetchOpenaiModels.mockReset();
  fetchGeminiModels.mockReset();
  bedrockSend.mockReset();
  bedrockDestroy.mockReset();
  bedrockClientConfigs.length = 0;
  fetchMock.mockReset();
  // Silence the provider-failure log and let tests assert its payload.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("listModelsForUser", () => {
  it("resolves an empty list without calling any provider when no credentials are configured", async () => {
    resolveModelCredentials.mockResolvedValue(creds({ source: "none" }));

    const result = await listModelsForUser(db, "user-1", "owner/repo");

    expect(result).toEqual({ models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchOpenaiModels).not.toHaveBeenCalled();
    expect(fetchGeminiModels).not.toHaveBeenCalled();
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it("forwards its db/user/repo arguments to credential resolution", async () => {
    resolveModelCredentials.mockResolvedValue(creds({ source: "none" }));

    await listModelsForUser(db, "user-1", "owner/repo");

    expect(resolveModelCredentials).toHaveBeenCalledExactlyOnceWith(
      db,
      "user-1",
      "owner/repo",
    );
  });

  it("lists Anthropic API models via the versioned REST endpoint with the key", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ anthropicApiKey: "sk-ant-key" }),
    );
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
      }),
    );

    const result = await listModelsForUser(db, "user-1");

    expect(result.models).toEqual([
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        provider: "anthropic",
        auth: "api_key",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        headers: {
          "x-api-key": "sk-ant-key",
          "anthropic-version": "2023-06-01",
        },
      },
    );
  });

  it("surfaces an Anthropic HTTP error through the aggregated failure message", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ anthropicApiKey: "sk-ant-bad" }),
    );
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () => Promise.resolve({}),
    });

    await expect(listModelsForUser(db, "user-1")).rejects.toThrow(
      "Failed to list models — anthropic: Anthropic API 401: Unauthorized",
    );
  });

  it("prefers Bedrock over an Anthropic key — the Anthropic API is never queried", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ aws, anthropicApiKey: "sk-ant-key" }),
    );
    bedrockSend.mockResolvedValue({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: "us.anthropic.claude-sonnet-4-6-v1:0",
          inferenceProfileName: "US Claude Sonnet 4.6",
        },
      ],
    });

    const result = await listModelsForUser(db, "user-1");

    expect(result.models).toEqual([
      {
        id: "us.anthropic.claude-sonnet-4-6-v1:0",
        label: "US Claude Sonnet 4.6",
        provider: "bedrock",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers the static Claude list for a subscription OAuth token", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ anthropicOauthToken: "sk-ant-oat01-x" }),
    );

    const { models } = await listModelsForUser(db, "user-1");

    // The exact ids track the current Claude model set, so pin the shape (all
    // anthropic/subscription, a Sonnet present) rather than mirroring the data.
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.provider).toBe("anthropic");
      expect(m.auth).toBe("subscription");
    }
    expect(models.some((m) => m.id.includes("sonnet"))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists API-key and subscription Claude models side by side when both are configured", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({
        anthropicApiKey: "sk-ant-key",
        anthropicOauthToken: "sk-ant-oat01-x",
      }),
    );
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
      }),
    );

    const { models } = await listModelsForUser(db, "user-1");

    const apiKeyModels = models.filter((m) => m.auth === "api_key");
    const subscriptionModels = models.filter((m) => m.auth === "subscription");
    expect(apiKeyModels).toEqual([
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        provider: "anthropic",
        auth: "api_key",
      },
    ]);
    expect(subscriptionModels.length).toBeGreaterThan(0);
    expect(apiKeyModels.length + subscriptionModels.length).toBe(models.length);
  });

  it("tags fetched OpenAI models with provider/auth and passes the key through", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ openaiApiKey: "sk-openai" }),
    );
    fetchOpenaiModels.mockResolvedValue([{ id: "gpt-5", label: "GPT-5" }]);

    const result = await listModelsForUser(db, "user-1");

    expect(result.models).toEqual([
      { id: "gpt-5", label: "GPT-5", provider: "openai", auth: "api_key" },
    ]);
    expect(fetchOpenaiModels).toHaveBeenCalledExactlyOnceWith("sk-openai");
  });

  it("offers the static Codex list for a ChatGPT-subscription auth.json", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ codexAuthJson: '{"tokens":{}}' }),
    );

    const { models } = await listModelsForUser(db, "user-1");

    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.provider).toBe("openai");
      expect(m.auth).toBe("subscription");
      expect(m.id).toMatch(/gpt/);
    }
    expect(fetchOpenaiModels).not.toHaveBeenCalled();
  });

  it("tags Gemini models with the provider and no auth kind", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ geminiApiKey: "sk-gemini" }),
    );
    fetchGeminiModels.mockResolvedValue([
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ]);

    const result = await listModelsForUser(db, "user-1");

    expect(result.models).toEqual([
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "gemini" },
    ]);
    // Gemini has a single credential kind, so no auth tag at all.
    expect(result.models[0]).not.toHaveProperty("auth");
    expect(fetchGeminiModels).toHaveBeenCalledExactlyOnceWith("sk-gemini");
  });

  it("keeps the surviving providers and logs the failure when one provider fails", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ openaiApiKey: "sk-openai", geminiApiKey: "sk-gemini" }),
    );
    fetchOpenaiModels.mockRejectedValue(new Error("boom"));
    fetchGeminiModels.mockResolvedValue([
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ]);

    const result = await listModelsForUser(db, "user-1");

    expect(result.models).toEqual([
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "gemini" },
    ]);
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "[bandolier:models] provider model list failed",
      { provider: "openai", error: "boom" },
    );
  });

  it("throws an aggregated per-provider error when every provider fails", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ openaiApiKey: "sk-openai", geminiApiKey: "sk-gemini" }),
    );
    fetchOpenaiModels.mockRejectedValue(new Error("key expired"));
    fetchGeminiModels.mockRejectedValue(new Error("quota"));

    await expect(listModelsForUser(db, "user-1")).rejects.toThrow(
      "Failed to list models — openai: key expired; gemini: quota",
    );
  });

  it("stringifies non-Error rejection reasons in the aggregated message", async () => {
    resolveModelCredentials.mockResolvedValue(
      creds({ openaiApiKey: "sk-openai" }),
    );
    fetchOpenaiModels.mockRejectedValue("nope");

    await expect(listModelsForUser(db, "user-1")).rejects.toThrow(
      "Failed to list models — openai: nope",
    );
  });

  describe("Bedrock", () => {
    it("prefers Claude inference profiles, falls label back to the id, and sorts by label", async () => {
      resolveModelCredentials.mockResolvedValue(creds({ aws }));
      bedrockSend.mockResolvedValue({
        inferenceProfileSummaries: [
          // No name — the label must fall back to the profile id.
          { inferenceProfileId: "us.anthropic.claude-opus-4-8-v1:0" },
          {
            inferenceProfileId: "us.anthropic.claude-sonnet-4-6-v1:0",
            inferenceProfileName: "Claude Sonnet 4.6 (US)",
          },
          // Not a Claude profile — filtered out.
          {
            inferenceProfileId: "us.meta.llama-3-70b",
            inferenceProfileName: "Llama 3",
          },
        ],
      });

      const result = await listModelsForUser(db, "user-1");

      // Sorted by label: "Claude Sonnet…" before "us.anthropic.claude-opus…".
      expect(result.models).toEqual([
        {
          id: "us.anthropic.claude-sonnet-4-6-v1:0",
          label: "Claude Sonnet 4.6 (US)",
          provider: "bedrock",
        },
        {
          id: "us.anthropic.claude-opus-4-8-v1:0",
          label: "us.anthropic.claude-opus-4-8-v1:0",
          provider: "bedrock",
        },
      ]);
      // Profiles found, so no fallback to foundation models.
      expect(bedrockSend).toHaveBeenCalledTimes(1);
      const command = bedrockSend.mock.calls[0]![0];
      expect(command.constructor.name).toBe("ListInferenceProfilesCommand");
      expect(command.input).toEqual({ typeEquals: "SYSTEM_DEFINED" });
      expect(bedrockDestroy).toHaveBeenCalledTimes(1);
    });

    it("falls back to ON_DEMAND foundation models when no Claude profiles exist", async () => {
      resolveModelCredentials.mockResolvedValue(creds({ aws }));
      bedrockSend
        .mockResolvedValueOnce({ inferenceProfileSummaries: [] })
        .mockResolvedValueOnce({
          modelSummaries: [
            {
              modelId: "anthropic.claude-3-haiku",
              modelName: "Claude 3 Haiku",
              inferenceTypesSupported: ["ON_DEMAND"],
            },
            // Not on-demand — filtered out.
            {
              modelId: "anthropic.claude-3-opus",
              modelName: "Claude 3 Opus",
              inferenceTypesSupported: ["PROVISIONED"],
            },
            // No name — the label must fall back to the model id.
            {
              modelId: "anthropic.claude-instant",
              inferenceTypesSupported: ["ON_DEMAND"],
            },
          ],
        });

      const result = await listModelsForUser(db, "user-1");

      // Sorted by label: "anthropic.claude-instant" before "Claude 3 Haiku".
      expect(result.models).toEqual([
        {
          id: "anthropic.claude-instant",
          label: "anthropic.claude-instant",
          provider: "bedrock",
        },
        {
          id: "anthropic.claude-3-haiku",
          label: "Claude 3 Haiku",
          provider: "bedrock",
        },
      ]);
      const fallback = bedrockSend.mock.calls[1]![0];
      expect(fallback.constructor.name).toBe("ListFoundationModelsCommand");
      expect(fallback.input).toEqual({ byProvider: "Anthropic" });
    });

    it("treats empty Bedrock responses as an empty list, not a failure", async () => {
      resolveModelCredentials.mockResolvedValue(creds({ aws }));
      // Both summaries fields undefined — the ?? [] branches must hold.
      bedrockSend.mockResolvedValue({});

      await expect(listModelsForUser(db, "user-1")).resolves.toEqual({
        models: [],
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("maps AWS SDK errors to a friendly message and still destroys the client", async () => {
      resolveModelCredentials.mockResolvedValue(creds({ aws }));
      bedrockSend.mockRejectedValue({ name: "ExpiredTokenException" });

      await expect(listModelsForUser(db, "user-1")).rejects.toThrow(
        /AWS credentials have expired/,
      );
      expect(bedrockDestroy).toHaveBeenCalledTimes(1);
    });

    it("constructs the client with the resolved region, keys, cleaned session token, and 2 attempts", async () => {
      resolveModelCredentials.mockResolvedValue(
        creds({
          aws: {
            accessKeyId: "AKIA_WEST",
            secretAccessKey: "west-secret",
            // Whitespace-only tokens must be dropped, not sent to AWS.
            sessionToken: "   ",
            region: "us-west-2",
          },
        }),
      );
      bedrockSend.mockResolvedValue({});

      await listModelsForUser(db, "user-1");

      expect(bedrockClientConfigs).toHaveLength(1);
      const config = bedrockClientConfigs[0]!;
      expect(config.region).toBe("us-west-2");
      expect(config.credentials?.accessKeyId).toBe("AKIA_WEST");
      expect(config.credentials?.secretAccessKey).toBe("west-secret");
      expect(config.credentials?.sessionToken).toBeUndefined();
      expect(config.maxAttempts).toBe(2);
    });
  });
});
