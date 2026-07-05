import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AwsCredentials, AwsValidation } from "~/server/agents/aws";
import type * as ComputeModule from "~/server/agents/compute";
import type { ComputeDefaults } from "~/server/agents/compute";
import type { ModelOption } from "~/server/agents/models";
import type {
  ModelCredentials,
  ProviderName,
} from "~/server/agents/resolve-credentials";

// resolveWebhookRun composes a handful of boundary helpers (the sender lookup,
// model listing, credential resolution, AWS validation, kubeconfig) around its
// own precedence logic. Mock those boundaries so every precedence/gating branch
// is drivable without a DB, network, or AWS; keep the pure parsers
// (`~/lib/effort`, `~/lib/compute`, and `mergeCompute`) real so the merge and
// label-parse behaviour under test is the real thing.

const getGithubAccountByGithubId =
  vi.fn<
    () => Promise<{ userId: string; accessToken: string | null } | null>
  >();
vi.mock("~/server/agents/github-token", () => ({
  getGithubAccountByGithubId: () => getGithubAccountByGithubId(),
}));

const resolveModelCredentials = vi.fn<() => Promise<ModelCredentials>>();
const selectRunCredentials =
  vi.fn<
    (
      resolved: ModelCredentials,
      opts: { modelProvider?: ProviderName },
    ) => {
      provider: ProviderName | null;
      authKind: null;
      aws: AwsCredentials | null;
      anthropicApiKey: string | null;
      anthropicOauthToken: string | null;
      openaiApiKey: string | null;
      codexAuthJson: string | null;
      geminiApiKey: string | null;
    }
  >();
vi.mock("~/server/agents/resolve-credentials", () => ({
  resolveModelCredentials: () => resolveModelCredentials(),
  selectRunCredentials: (
    resolved: ModelCredentials,
    opts: { modelProvider?: ProviderName },
  ) => selectRunCredentials(resolved, opts),
}));

const listModelsForUser = vi.fn<() => Promise<{ models: ModelOption[] }>>();
const fuzzyPickModel =
  vi.fn<(query: string, models: ModelOption[]) => string | undefined>();
const pickDefaultModel = vi.fn<(models: ModelOption[]) => string | undefined>();
const pickPrWriterModel =
  vi.fn<
    (models: ModelOption[], selected: ModelOption | undefined) =>
      | string
      | undefined
  >();
vi.mock("~/server/agents/models", () => ({
  listModelsForUser: () => listModelsForUser(),
  fuzzyPickModel: (query: string, models: ModelOption[]) =>
    fuzzyPickModel(query, models),
  pickDefaultModel: (models: ModelOption[]) => pickDefaultModel(models),
  pickPrWriterModel: (models: ModelOption[], selected: ModelOption | undefined) =>
    pickPrWriterModel(models, selected),
}));

const resolveCompute = vi.fn<() => Promise<ComputeDefaults>>();
vi.mock("~/server/agents/compute", async (importActual) => {
  const actual = await importActual<typeof ComputeModule>();
  return { ...actual, resolveCompute: () => resolveCompute() };
});

const validateAwsCredentials =
  vi.fn<(creds: AwsCredentials) => Promise<AwsValidation>>();
vi.mock("~/server/agents/aws", () => ({
  validateAwsCredentials: (creds: AwsCredentials) =>
    validateAwsCredentials(creds),
}));

const resolveKubeconfig = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/kubeconfig", () => ({
  resolveKubeconfig: () => resolveKubeconfig(),
}));

// No test touches the database — every helper that would is mocked above.
vi.mock("~/server/db", () => ({ db: {} }));

const { resolveWebhookRun } = await import("~/server/webhooks/resolve-run");

const aws: AwsCredentials = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  region: "us-east-1",
};

const NO_CREDENTIALS = {
  provider: null as ProviderName | null,
  authKind: null,
  aws: null,
  anthropicApiKey: null,
  anthropicOauthToken: null,
  openaiApiKey: null,
  codexAuthJson: null,
  geminiApiKey: null,
};

function model(overrides: Partial<ModelOption>): ModelOption {
  return {
    id: "claude-sonnet",
    label: "Claude Sonnet",
    provider: "anthropic",
    ...overrides,
  };
}

function baseOpts(overrides: Partial<Parameters<typeof resolveWebhookRun>[0]>) {
  return {
    sender: { id: 42, login: "octocat" },
    repoFullName: "acme/widgets",
    labels: [] as { name: string }[],
    defaultModel: null,
    defaultEffort: null,
    logCtx: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible happy-path defaults; individual tests override what they exercise.
  getGithubAccountByGithubId.mockResolvedValue({
    userId: "user-1",
    accessToken: "gh-token",
  });
  resolveModelCredentials.mockResolvedValue({
    aws: null,
    anthropicApiKey: "sk-ant",
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
    source: "user",
  });
  listModelsForUser.mockResolvedValue({
    models: [model({ id: "claude-sonnet" }), model({ id: "claude-opus" })],
  });
  fuzzyPickModel.mockReturnValue(undefined);
  pickDefaultModel.mockReturnValue("claude-sonnet");
  pickPrWriterModel.mockReturnValue("claude-sonnet");
  resolveCompute.mockResolvedValue({ cpu: null, memory: null });
  resolveKubeconfig.mockResolvedValue("kubeconfig-yaml");
  validateAwsCredentials.mockResolvedValue({ valid: true });
  selectRunCredentials.mockReturnValue({
    ...NO_CREDENTIALS,
    provider: "anthropic",
    anthropicApiKey: "sk-ant",
  });
});

describe("resolveWebhookRun — prerequisites", () => {
  it("returns null when the sender is not a Bandolier user", async () => {
    getGithubAccountByGithubId.mockResolvedValue(null);
    expect(await resolveWebhookRun(baseOpts({}))).toBeNull();
    expect(listModelsForUser).not.toHaveBeenCalled();
  });

  it("returns null when the sender has no model credentials", async () => {
    listModelsForUser.mockResolvedValue({ models: [] });
    expect(await resolveWebhookRun(baseOpts({}))).toBeNull();
  });

  it("returns null when no kubeconfig resolves", async () => {
    resolveKubeconfig.mockResolvedValue(null);
    expect(await resolveWebhookRun(baseOpts({}))).toBeNull();
  });
});

describe("resolveWebhookRun — model precedence", () => {
  it("prefers a model: label over the repo default and the provider default", async () => {
    fuzzyPickModel.mockReturnValue("claude-opus");
    const run = await resolveWebhookRun(
      baseOpts({
        labels: [{ name: "model:opus" }],
        defaultModel: "claude-sonnet",
      }),
    );
    expect(run?.model).toBe("claude-opus");
    expect(fuzzyPickModel).toHaveBeenCalledWith("opus", expect.anything());
    expect(pickDefaultModel).not.toHaveBeenCalled();
  });

  it("prefers the repo default over the provider default when it is listed", async () => {
    const run = await resolveWebhookRun(
      baseOpts({ defaultModel: "claude-opus" }),
    );
    expect(run?.model).toBe("claude-opus");
    expect(pickDefaultModel).not.toHaveBeenCalled();
  });

  it("ignores an unlisted repo default and falls through to the provider default", async () => {
    pickDefaultModel.mockReturnValue("claude-sonnet");
    const run = await resolveWebhookRun(
      baseOpts({ defaultModel: "gpt-not-in-list" }),
    );
    expect(run?.model).toBe("claude-sonnet");
    expect(pickDefaultModel).toHaveBeenCalled();
  });

  it("falls through to the provider default when a model: label matches nothing", async () => {
    fuzzyPickModel.mockReturnValue(undefined);
    pickDefaultModel.mockReturnValue("claude-sonnet");
    const run = await resolveWebhookRun(
      baseOpts({ labels: [{ name: "model:nope" }] }),
    );
    expect(run?.model).toBe("claude-sonnet");
  });

  it("returns null when no model can be chosen", async () => {
    pickDefaultModel.mockReturnValue(undefined);
    expect(await resolveWebhookRun(baseOpts({}))).toBeNull();
  });
});

describe("resolveWebhookRun — effort precedence", () => {
  it("resolves an effort: label for an effort-supporting provider", async () => {
    pickDefaultModel.mockReturnValue("claude-sonnet");
    const run = await resolveWebhookRun(
      baseOpts({
        labels: [{ name: "effort:high" }],
        defaultEffort: "low",
      }),
    );
    expect(run?.specBase.effort).toBe("high");
  });

  it("falls back to the repo default when the effort: label value is unknown", async () => {
    const run = await resolveWebhookRun(
      baseOpts({
        labels: [{ name: "effort:bogus" }],
        defaultEffort: "medium",
      }),
    );
    expect(run?.specBase.effort).toBe("medium");
  });

  it("leaves effort unset for a provider that does not support it", async () => {
    listModelsForUser.mockResolvedValue({
      models: [model({ id: "gpt-5", provider: "openai" })],
    });
    pickDefaultModel.mockReturnValue("gpt-5");
    selectRunCredentials.mockReturnValue({
      ...NO_CREDENTIALS,
      provider: "openai",
      openaiApiKey: "sk-openai",
    });
    const run = await resolveWebhookRun(
      baseOpts({
        labels: [{ name: "effort:high" }],
        defaultEffort: "high",
      }),
    );
    expect(run?.specBase.effort).toBeUndefined();
  });
});

describe("resolveWebhookRun — compute precedence", () => {
  it("ignores an invalid cpu label and merges a valid memory label over the defaults", async () => {
    resolveCompute.mockResolvedValue({ cpu: "2", memory: "2Gi" });
    const run = await resolveWebhookRun(
      baseOpts({
        labels: [{ name: "cpu:not-a-number" }, { name: "memory:8Gi" }],
      }),
    );
    expect(run?.specBase.compute).toEqual({ cpu: "2", memory: "8Gi" });
  });

  it("merges a valid cpu label over the resolveCompute default", async () => {
    resolveCompute.mockResolvedValue({ cpu: "2", memory: "2Gi" });
    const run = await resolveWebhookRun(
      baseOpts({ labels: [{ name: "cpu:4" }] }),
    );
    expect(run?.specBase.compute).toEqual({ cpu: "4", memory: "2Gi" });
  });

  it("leaves compute undefined when neither a label nor a default is set", async () => {
    resolveCompute.mockResolvedValue({ cpu: null, memory: null });
    const run = await resolveWebhookRun(baseOpts({}));
    expect(run?.specBase.compute).toBeUndefined();
  });
});

describe("resolveWebhookRun — credential gating", () => {
  it("returns null when no credentials are selected for the model", async () => {
    selectRunCredentials.mockReturnValue({ ...NO_CREDENTIALS });
    expect(await resolveWebhookRun(baseOpts({}))).toBeNull();
    expect(validateAwsCredentials).not.toHaveBeenCalled();
  });

  it("returns null when the selected AWS credentials fail validation", async () => {
    listModelsForUser.mockResolvedValue({
      models: [model({ id: "claude-bedrock", provider: "bedrock" })],
    });
    pickDefaultModel.mockReturnValue("claude-bedrock");
    selectRunCredentials.mockReturnValue({
      ...NO_CREDENTIALS,
      provider: "bedrock",
      aws,
    });
    validateAwsCredentials.mockResolvedValue({
      valid: false,
      error: "bad creds",
    });
    expect(await resolveWebhookRun(baseOpts({}))).toBeNull();
    expect(validateAwsCredentials).toHaveBeenCalledWith(aws);
  });

  it("routes credential selection by the chosen model's provider and returns the spec", async () => {
    const run = await resolveWebhookRun(baseOpts({}));
    expect(run).not.toBeNull();
    expect(selectRunCredentials).toHaveBeenCalledWith(expect.anything(), {
      modelProvider: "anthropic",
    });
    expect(run?.specBase).toMatchObject({
      model: "claude-sonnet",
      kubeconfig: "kubeconfig-yaml",
      anthropicApiKey: "sk-ant",
      prWriterModel: "claude-sonnet",
    });
    expect(run?.linked.userId).toBe("user-1");
  });

  it("passes valid AWS credentials through to the spec", async () => {
    listModelsForUser.mockResolvedValue({
      models: [model({ id: "claude-bedrock", provider: "bedrock" })],
    });
    pickDefaultModel.mockReturnValue("claude-bedrock");
    selectRunCredentials.mockReturnValue({
      ...NO_CREDENTIALS,
      provider: "bedrock",
      aws,
    });
    validateAwsCredentials.mockResolvedValue({ valid: true });
    const run = await resolveWebhookRun(baseOpts({}));
    expect(run?.specBase.awsCredentials).toEqual(aws);
  });
});
