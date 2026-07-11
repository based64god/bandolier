import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listCustomProviderModels,
  mergeCustomProviders,
  normalizeCustomProviderInput,
  validateCustomProviderInput,
  type CustomProviderCredential,
} from "~/server/agents/custom-providers";
import { gollmProviderEnv } from "~/server/agents/gollm-catalog";

const cred = (provider: string, apiKey: string): CustomProviderCredential => ({
  provider,
  apiKey,
  apiBase: null,
  extraEnv: null,
  models: null,
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
