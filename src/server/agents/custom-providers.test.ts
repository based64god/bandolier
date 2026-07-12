import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getRepoCustomProviders,
  getUserCustomProviders,
  listCustomProviderModels,
  mergeCustomProviders,
  normalizeCustomProviderInput,
  validateCustomProviderInput,
  type CustomProviderCredential,
} from "~/server/agents/custom-providers";
import { gollmProviderEnv } from "~/server/agents/gollm-catalog";
import { type Validation } from "~/server/agents/validation";
import { type db } from "~/server/db";

// validateCustomProviderInput's probe path delegates to probeApiKey; stub it so
// the "listable hosted key gets probed" branch is driven without a real fetch.
const probeApiKeyFn =
  vi.fn<
    (
      url: string,
      headers: Record<string, string>,
      name: string,
    ) => Promise<Validation>
  >();
vi.mock("~/server/agents/validation", () => ({
  probeApiKey: (url: string, headers: Record<string, string>, name: string) =>
    probeApiKeyFn(url, headers, name),
}));

const cred = (provider: string, apiKey: string): CustomProviderCredential => ({
  provider,
  apiKey,
  apiBase: null,
  extraEnv: null,
  models: null,
});

// The stored-row shape both scoped tables share (JSON columns as text).
interface StoredRow {
  provider: string;
  apiKey: string | null;
  apiBase: string | null;
  extraEnv: string | null;
  models: string | null;
}

// getUser/getRepoCustomProviders only exercise .select().from().where(); a chain
// whose .where() resolves to the given rows is enough (the eq() condition is
// built with the real schema columns but discarded here).
function fakeDb(rows: StoredRow[]): typeof db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return chain as never;
}

describe("getUserCustomProviders", () => {
  it("drops catalog-unknown rows and parses the JSON columns per row", async () => {
    // One unknown provider (filtered) plus six catalog-known rows, each hitting
    // a distinct parseJSONObject / parseModels branch.
    const rows: StoredRow[] = [
      // Unknown provider — filtered out before rowToCredential runs.
      {
        provider: "nope",
        apiKey: "x",
        apiBase: null,
        extraEnv: null,
        models: null,
      },
      // Object extraEnv: only string values survive (number/array/null dropped);
      // models array with a non-string element is filtered to strings.
      {
        provider: "groq",
        apiKey: "gsk",
        apiBase: "https://groq.custom/v1",
        extraEnv: '{"A":"1","B":2,"C":["x"],"D":null}',
        models: '["m1",7,"m2"]',
      },
      // Array extraEnv → not an object → null; empty models array → null.
      {
        provider: "openrouter",
        apiKey: "or",
        apiBase: null,
        extraEnv: '["a","b"]',
        models: "[]",
      },
      // Invalid-JSON extraEnv → caught → null; non-array (string) models → null.
      {
        provider: "together",
        apiKey: null,
        apiBase: null,
        extraEnv: "oops{",
        models: '"str"',
      },
      // Number extraEnv → typeof !== object → null; object (non-array) models → null.
      {
        provider: "xai",
        apiKey: "xk",
        apiBase: null,
        extraEnv: "42",
        models: '{"a":1}',
      },
      // JSON null extraEnv → parsed === null → null; invalid-JSON models → caught → null.
      {
        provider: "deepseek",
        apiKey: "dk",
        apiBase: null,
        extraEnv: "null",
        models: "bad json",
      },
      // Null columns → the early !raw returns for both parsers.
      {
        provider: "cerebras",
        apiKey: "ck",
        apiBase: null,
        extraEnv: null,
        models: null,
      },
    ];

    const result = await getUserCustomProviders(fakeDb(rows), "u1");

    expect(result).toEqual([
      {
        provider: "groq",
        apiKey: "gsk",
        apiBase: "https://groq.custom/v1",
        extraEnv: { A: "1" },
        models: ["m1", "m2"],
      },
      {
        provider: "openrouter",
        apiKey: "or",
        apiBase: null,
        extraEnv: null,
        models: null,
      },
      {
        provider: "together",
        apiKey: null,
        apiBase: null,
        extraEnv: null,
        models: null,
      },
      {
        provider: "xai",
        apiKey: "xk",
        apiBase: null,
        extraEnv: null,
        models: null,
      },
      {
        provider: "deepseek",
        apiKey: "dk",
        apiBase: null,
        extraEnv: null,
        models: null,
      },
      {
        provider: "cerebras",
        apiKey: "ck",
        apiBase: null,
        extraEnv: null,
        models: null,
      },
    ]);
  });
});

describe("getRepoCustomProviders", () => {
  it("keeps only catalog-known rows and parses their JSON columns", async () => {
    const rows: StoredRow[] = [
      {
        provider: "nope",
        apiKey: "x",
        apiBase: null,
        extraEnv: null,
        models: null,
      },
      {
        provider: "together",
        apiKey: "tg",
        apiBase: "https://x/v1",
        extraEnv: '{"K":"v"}',
        models: '["a"]',
      },
    ];

    const result = await getRepoCustomProviders(fakeDb(rows), "acme/app");

    expect(result).toEqual([
      {
        provider: "together",
        apiKey: "tg",
        apiBase: "https://x/v1",
        extraEnv: { K: "v" },
        models: ["a"],
      },
    ]);
  });
});

describe("normalizeCustomProviderInput", () => {
  it("packs the key field into apiKey and the rest into extraEnv", () => {
    // watsonx: WATSONX_APIKEY (key) + WATSONX_URL (base) + WATSONX_PROJECT_ID.
    const row = normalizeCustomProviderInput({
      provider: "watsonx",
      fields: {
        WATSONX_APIKEY: "  wx-key  ",
        WATSONX_URL: "https://us-south.ml.cloud.ibm.com",
        WATSONX_PROJECT_ID: "proj-1",
        UNSET: "",
      },
      models: "granite, llama\nmixtral",
    });
    expect(row).toEqual({
      provider: "watsonx",
      apiKey: "wx-key",
      apiBase: "https://us-south.ml.cloud.ibm.com",
      extraEnv: '{"WATSONX_PROJECT_ID":"proj-1"}',
      models: '["granite","llama","mixtral"]',
    });
  });

  it("stores every field in extraEnv for a keyless provider (SageMaker)", () => {
    const row = normalizeCustomProviderInput({
      provider: "sagemaker",
      fields: {
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: "us-east-1",
      },
    });
    expect(row.apiKey).toBeNull();
    expect(row.apiBase).toBeNull();
    expect(JSON.parse(row.extraEnv!)).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA1",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "us-east-1",
    });
  });
});

describe("validateCustomProviderInput", () => {
  beforeEach(() => probeApiKeyFn.mockReset());

  it("rejects an unknown provider", async () => {
    const r = await validateCustomProviderInput({
      provider: "nope",
      fields: {},
    });
    expect(r.valid).toBe(false);
  });

  it("requires the key field for a keyed provider (offline check)", async () => {
    // github_copilot is not listable, so no network probe runs.
    const r = await validateCustomProviderInput({
      provider: "github_copilot",
      fields: {},
    });
    expect(r).toMatchObject({ valid: false });
  });

  it("requires each declared field of a bespoke provider (OCI)", async () => {
    // Only the PEM given; the identity fields are missing.
    const r = await validateCustomProviderInput({
      provider: "oci",
      fields: { OCI_KEY: "-----BEGIN PRIVATE KEY-----\n…" },
      models: "meta.llama",
    });
    expect(r).toMatchObject({ valid: false });
    expect((r as { error: string }).error).toMatch(/OCI/);
  });

  it("accepts a bespoke provider with every required field", async () => {
    const r = await validateCustomProviderInput({
      provider: "oci",
      fields: {
        OCI_KEY: "-----BEGIN PRIVATE KEY-----\n…",
        OCI_USER: "ocid1.user",
        OCI_FINGERPRINT: "aa:bb",
        OCI_TENANCY: "ocid1.tenancy",
        OCI_COMPARTMENT_ID: "ocid1.compartment",
        // OCI_REGION is optional.
      },
      models: "meta.llama-3.3-70b-instruct",
    });
    expect(r).toEqual({ valid: true });
  });

  it("requires the endpoint field for a self-hosted provider", async () => {
    const r = await validateCustomProviderInput({
      provider: "hosted_vllm",
      fields: {},
    });
    expect(r).toMatchObject({ valid: false });
  });

  it("requires a model list for a non-listable provider", async () => {
    const r = await validateCustomProviderInput({
      provider: "replicate",
      fields: { REPLICATE_API_TOKEN: "r8-x" },
    });
    expect(r).toMatchObject({ valid: false });
  });

  it("accepts a non-listable provider with models and no probe", async () => {
    const r = await validateCustomProviderInput({
      provider: "replicate",
      fields: { REPLICATE_API_TOKEN: "r8-x" },
      models: "meta/llama-3-70b",
    });
    expect(r).toEqual({ valid: true });
    expect(probeApiKeyFn).not.toHaveBeenCalled();
  });

  it("probes a listable hosted provider's key and returns the probe result", async () => {
    // groq: listable, defaultBase present, key field, no endpoint field → the
    // default base is probed with the Bearer key. A failing probe must surface.
    probeApiKeyFn.mockResolvedValue({
      valid: false,
      error: "API key is invalid.",
    });
    const r = await validateCustomProviderInput({
      provider: "groq",
      fields: { GROQ_API_KEY: "gsk-test" },
    });
    expect(probeApiKeyFn).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      { Authorization: "Bearer gsk-test" },
      "Groq",
    );
    // The probe result (not the fall-through valid:true) is what's returned.
    expect(r).toEqual({ valid: false, error: "API key is invalid." });
  });
});

describe("listCustomProviderModels", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists from the OpenAI-compatible endpoint and merges stored ids", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "llama-3.3-70b" }, { id: "mixtral" }] }),
        { status: 200 },
      ),
    );
    const models = await listCustomProviderModels({
      provider: "groq",
      apiKey: "gsk",
      apiBase: null,
      extraEnv: null,
      models: ["my-alias"],
    });
    expect(models.map((m) => m.id)).toEqual([
      "llama-3.3-70b",
      "mixtral",
      "my-alias",
    ]);
  });

  it("falls back to stored models when the endpoint fails", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    const models = await listCustomProviderModels({
      provider: "groq",
      apiKey: "gsk",
      apiBase: null,
      extraEnv: null,
      models: ["only-this"],
    });
    expect(models.map((m) => m.id)).toEqual(["only-this"]);
  });

  it("rethrows the fetch error when nothing is stored to fall back to", async () => {
    // Network reject + empty stored list → the catch has no fallback, so the
    // underlying error propagates.
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    await expect(
      listCustomProviderModels({
        provider: "groq",
        apiKey: "gsk",
        apiBase: null,
        extraEnv: null,
        models: null,
      }),
    ).rejects.toThrow("network down");
  });

  it("throws for a non-listable provider with no stored models", async () => {
    // replicate isn't listable and has no defaultBase, so an empty model list
    // leaves nothing to show.
    await expect(
      listCustomProviderModels({
        provider: "replicate",
        apiKey: "r8",
        apiBase: null,
        extraEnv: null,
        models: null,
      }),
    ).rejects.toThrow(/no models configured/);
  });

  it("uses stored models directly for a non-listable provider", async () => {
    const models = await listCustomProviderModels({
      provider: "replicate",
      apiKey: "r8",
      apiBase: null,
      extraEnv: null,
      models: ["meta/llama-3-70b"],
    });
    expect(models).toEqual([
      { id: "meta/llama-3-70b", label: "meta/llama-3-70b" },
    ]);
  });
});

describe("mergeCustomProviders", () => {
  it("lets primary win per provider id and fills gaps from fallback", () => {
    const merged = mergeCustomProviders(
      [cred("groq", "repo-groq"), cred("together", "repo-tg")],
      [cred("groq", "user-groq"), cred("openrouter", "user-or")],
    );
    const byId = Object.fromEntries(merged.map((c) => [c.provider, c.apiKey]));
    expect(byId).toEqual({
      groq: "repo-groq",
      together: "repo-tg",
      openrouter: "user-or",
    });
  });

  it("returns the fallback when primary is empty", () => {
    expect(mergeCustomProviders([], [cred("groq", "k")])).toEqual([
      cred("groq", "k"),
    ]);
  });
});

describe("gollmProviderEnv", () => {
  it("maps key + endpoint onto the provider's env vars, plus extra verbatim", () => {
    const env = gollmProviderEnv({
      provider: "hosted_vllm",
      apiKey: "vk",
      apiBase: "http://box:8000/v1",
      extraEnv: { CUSTOM: "z" },
    });
    expect(env).toEqual({
      HOSTED_VLLM_API_KEY: "vk",
      HOSTED_VLLM_API_BASE: "http://box:8000/v1",
      CUSTOM: "z",
    });
  });

  it("drops empty values and unknown providers", () => {
    expect(
      gollmProviderEnv({
        provider: "groq",
        apiKey: null,
        apiBase: null,
        extraEnv: { A: "", B: "keep" },
      }),
    ).toEqual({ B: "keep" });
  });
});
