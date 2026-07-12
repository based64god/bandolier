import { describe, expect, it } from "vitest";

import {
  baseFieldOf,
  gollmProviderInfo,
  keyFieldOf,
  providerFields,
  providerPriority,
  type GollmProviderInfo,
} from "./gollm-catalog";

// The settings "credential accordion" renders each provider's form from
// `providerFields`, showing the field placeholder and hint (and the entry
// hint). These tests pin the plumbing that carries the credential-shape hints
// through — a key's expected prefix, a self-hosted endpoint's URL shape — plus
// a coverage floor so the common providers never regress to a bare form.

/** Does the provider's form surface any credential-shape guidance? */
function surfacesShapeHint(info: GollmProviderInfo): boolean {
  return (
    !!info.hint || providerFields(info).some((f) => !!(f.placeholder ?? f.hint))
  );
}

describe("providerFields shape hints", () => {
  it("threads keyPlaceholder/keyHint/basePlaceholder onto the derived fields", () => {
    const info: GollmProviderInfo = {
      id: "x",
      label: "X",
      keyEnv: "X_API_KEY",
      keyPlaceholder: "xk-…",
      keyHint: "a note",
      baseEnv: "X_API_BASE",
      needsBase: true,
      basePlaceholder: "http://host:1234/v1",
    };
    const key = keyFieldOf(info);
    const base = baseFieldOf(info);
    expect(key?.placeholder).toBe("xk-…");
    expect(key?.hint).toBe("a note");
    expect(base?.placeholder).toBe("http://host:1234/v1");
  });

  it("ignores the info-level hints when explicit fields are declared", () => {
    // Bespoke-auth providers carry their placeholders on the fields themselves;
    // the derived-form keyPlaceholder must not leak in.
    const info: GollmProviderInfo = {
      id: "y",
      label: "Y",
      keyPlaceholder: "should-be-ignored",
      fields: [{ env: "Y_KEY", label: "API key", kind: "secret", role: "key" }],
    };
    expect(keyFieldOf(info)?.placeholder).toBeUndefined();
  });

  it("shows the documented key prefix for well-known providers", () => {
    expect(keyFieldOf(gollmProviderInfo("groq")!)?.placeholder).toBe("gsk_…");
    expect(keyFieldOf(gollmProviderInfo("openrouter")!)?.placeholder).toBe(
      "sk-or-v1-…",
    );
    expect(keyFieldOf(gollmProviderInfo("xai")!)?.placeholder).toBe("xai-…");
    expect(keyFieldOf(gollmProviderInfo("huggingface")!)?.placeholder).toBe(
      "hf_…",
    );
  });

  it("shows the endpoint URL shape for self-hosted backends", () => {
    expect(baseFieldOf(gollmProviderInfo("lm_studio")!)?.placeholder).toBe(
      "http://localhost:1234/v1",
    );
    expect(baseFieldOf(gollmProviderInfo("hosted_vllm")!)?.placeholder).toBe(
      "http://localhost:8000/v1",
    );
    expect(baseFieldOf(gollmProviderInfo("azure_ai")!)?.placeholder).toContain(
      "services.ai.azure.com",
    );
  });
});

describe("catalog shape-hint coverage", () => {
  // The commonly-used providers must always give the user a shape hint (a key
  // prefix, an endpoint URL, or a where-to-get-it note) rather than a bare
  // "API key" field. Obscure long-tail gateways are intentionally omitted — we
  // don't ship a guessed key format.
  const CORE_PROVIDERS = [
    // Hosted inference clouds & model vendors.
    "groq",
    "mistral",
    "codestral",
    "deepseek",
    "xai",
    "together",
    "fireworks",
    "openrouter",
    "perplexity",
    "cerebras",
    "moonshot",
    "nvidia",
    "deepinfra",
    "ai21",
    "sambanova",
    "nebius",
    "novita",
    "dashscope",
    "hyperbolic",
    "lambda_ai",
    "huggingface",
    "github",
    "wandb",
    "poe",
    "scaleway",
    "gradient_ai",
    "v0",
    "vercel_ai_gateway",
    // Gateways / self-hosted backends (endpoint required).
    "cloudflare",
    "databricks",
    "azure_ai",
    "litellm_proxy",
    "heroku",
    "openai_like",
    "hosted_vllm",
    "llamafile",
    "lm_studio",
    "docker_model_runner",
    "lemonade",
    "xinference",
    "ragflow",
    "oobabooga",
    // Bespoke-auth providers.
    "github_copilot",
    "replicate",
    "watsonx",
    "snowflake",
    "gigachat",
    "oci",
    "predibase",
    "clarifai",
  ] as const;

  it.each(CORE_PROVIDERS)("%s surfaces a credential-shape hint", (id) => {
    const info = gollmProviderInfo(id);
    expect(info, `unknown provider "${id}"`).toBeDefined();
    expect(surfacesShapeHint(info!)).toBe(true);
  });
});

describe("provider metadata", () => {
  it("weights common providers above the long tail, below the first-class band", () => {
    expect(providerPriority("groq")).toBeGreaterThan(0);
    // Never outranks the four first-class providers (70–100).
    expect(providerPriority("groq")).toBeLessThan(70);
    // An obscure long-tail gateway gets the default weight.
    expect(providerPriority("darkbloom")).toBe(0);
  });

  it("marks subscription-style backends", () => {
    expect(gollmProviderInfo("github_copilot")?.subscription).toBe(true);
    expect(gollmProviderInfo("groq")?.subscription).toBeUndefined();
  });
});
