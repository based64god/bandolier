// The catalog of model providers served through the harness's embedded gollm
// proxy — every provider gollm supports beyond the four first-class ones
// (Anthropic, Bedrock, OpenAI, Gemini). One entry describes everything the
// rest of the system needs: the settings UI renders the picker and field
// hints from it, the account router validates against it, the model picker
// decides whether GET {base}/models works, and create-job maps the stored
// credential onto the env vars gollm reads inside the pod.
//
// `id` values are gollm's canonical provider names (see gollm/providers), so
// the harness passes them straight through as the proxy's backend prefix.

/** How a credential field renders in the settings form. */
export type CredentialFieldKind = "secret" | "text" | "textarea";

/**
 * One credential a provider needs, mapped to the env var gollm reads it from.
 * This is what makes each provider's form bespoke: the set of fields, their
 * labels, and their input types match the provider's real credential shape
 * (a bare API key for Groq, an endpoint + optional key for a self-hosted vLLM,
 * a PEM plus five identity fields for OCI, …).
 */
export interface CredentialField {
  /** The env var this value is injected into the pod as. */
  env: string;
  /** Form label. */
  label: string;
  placeholder?: string;
  /** Input type; defaults to "secret" (masked). */
  kind?: CredentialFieldKind;
  /** Optional field (default required). */
  optional?: boolean;
  /**
   * `key` marks the bearer used for the OpenAI-compatible /models probe and
   * listing; `base` marks the endpoint. At most one of each. Fields with no
   * role are plain extra env (a project id, a region, …).
   */
  role?: "key" | "base";
  /** Per-field note shown under the input. */
  hint?: string;
}

export interface GollmProviderInfo {
  /** gollm's canonical provider name (the model-string prefix). */
  id: string;
  /** Human label for pickers and badges. */
  label: string;
  /**
   * The env var gollm reads the API key from. Optional: providers whose
   * credential isn't a single bearer (SageMaker's AWS keys, …) declare their
   * fields explicitly instead.
   */
  keyEnv?: string;
  /** The env var gollm reads the endpoint from (when overridable). */
  baseEnv?: string;
  /** Endpoint required (self-hosted / account-scoped backends). */
  needsBase?: boolean;
  /** Keyless backends (local servers) — the key field is optional. */
  keyOptional?: boolean;
  /**
   * Explicit credential fields, for providers whose shape isn't captured by
   * keyEnv/baseEnv (the bespoke-auth backends). When absent, `providerFields`
   * derives a clean key (+ endpoint) form from keyEnv/baseEnv.
   */
  fields?: CredentialField[];
  /**
   * Serves an OpenAI-compatible GET {base}/models the picker can list from.
   * Providers without it need a user-supplied model list.
   */
  listable?: boolean;
  /** The default endpoint used for model listing when none is stored. */
  defaultBase?: string;
  /** One-line settings hint (key format, extra env the provider needs). */
  hint?: string;
  /**
   * Credential-shape hints for the derived key/base form (providers without
   * explicit `fields`): the API key's placeholder (its distinctive prefix, e.g.
   * "gsk_…"), an optional per-field note under the key input, and the endpoint
   * field's placeholder (its URL shape, e.g. "http://localhost:1234/v1"). They
   * flow straight onto the corresponding derived field in `providerFields`, so
   * every provider's form indicates the shape it expects — like the first-class
   * Anthropic/OpenAI/Gemini/Bedrock forms do. Ignored when `fields` is set (put
   * the placeholder/hint on the field there).
   */
  keyPlaceholder?: string;
  keyHint?: string;
  basePlaceholder?: string;
  /**
   * Subscription-style backend (a login/session token rather than a metered API
   * key) — e.g. GitHub Copilot. Tags its models `auth: "subscription"` in the
   * picker so they badge like the Anthropic/OpenAI subscription options.
   */
  subscription?: boolean;
}

const p = (info: GollmProviderInfo) => info;

// Field constructors for the bespoke providers below.
const secret = (
  env: string,
  label: string,
  extra: Partial<CredentialField> = {},
): CredentialField => ({ env, label, kind: "secret", ...extra });
const text = (
  env: string,
  label: string,
  extra: Partial<CredentialField> = {},
): CredentialField => ({ env, label, kind: "text", ...extra });

export const GOLLM_PROVIDERS: readonly GollmProviderInfo[] = [
  // ── Hosted inference clouds and model vendors ─────────────────────────────
  p({
    id: "groq",
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    keyPlaceholder: "gsk_…",
    listable: true,
    defaultBase: "https://api.groq.com/openai/v1",
  }),
  p({
    id: "mistral",
    label: "Mistral",
    keyEnv: "MISTRAL_API_KEY",
    keyHint: "A Mistral API key (console.mistral.ai).",
    baseEnv: "MISTRAL_API_BASE",
    listable: true,
    defaultBase: "https://api.mistral.ai/v1",
  }),
  p({
    id: "codestral",
    label: "Mistral Codestral",
    keyEnv: "CODESTRAL_API_KEY",
    keyHint: "A Mistral Codestral API key (console.mistral.ai).",
    baseEnv: "CODESTRAL_API_BASE",
  }),
  p({
    id: "deepseek",
    label: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    keyPlaceholder: "sk-…",
    baseEnv: "DEEPSEEK_API_BASE",
    listable: true,
    defaultBase: "https://api.deepseek.com/v1",
  }),
  p({
    id: "xai",
    label: "xAI (Grok)",
    keyEnv: "XAI_API_KEY",
    keyPlaceholder: "xai-…",
    listable: true,
    defaultBase: "https://api.x.ai/v1",
  }),
  p({
    id: "together",
    label: "Together AI",
    keyEnv: "TOGETHER_API_KEY",
    keyHint: "A Together AI API key (api.together.xyz).",
    baseEnv: "TOGETHER_AI_API_BASE",
    listable: true,
    defaultBase: "https://api.together.xyz/v1",
  }),
  p({
    id: "fireworks",
    label: "Fireworks AI",
    keyEnv: "FIREWORKS_API_KEY",
    keyPlaceholder: "fw_…",
  }),
  p({
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    keyPlaceholder: "sk-or-v1-…",
    listable: true,
    defaultBase: "https://openrouter.ai/api/v1",
  }),
  p({
    id: "perplexity",
    label: "Perplexity",
    keyEnv: "PERPLEXITY_API_KEY",
    keyPlaceholder: "pplx-…",
  }),
  p({
    id: "cerebras",
    label: "Cerebras",
    keyEnv: "CEREBRAS_API_KEY",
    keyPlaceholder: "csk-…",
    baseEnv: "CEREBRAS_API_BASE",
    listable: true,
    defaultBase: "https://api.cerebras.ai/v1",
  }),
  p({
    id: "moonshot",
    label: "Moonshot (Kimi)",
    keyEnv: "MOONSHOT_API_KEY",
    keyPlaceholder: "sk-…",
    baseEnv: "MOONSHOT_API_BASE",
    listable: true,
    defaultBase: "https://api.moonshot.ai/v1",
  }),
  p({
    id: "nvidia",
    label: "NVIDIA NIM",
    keyEnv: "NVIDIA_NIM_API_KEY",
    keyPlaceholder: "nvapi-…",
    baseEnv: "NVIDIA_NIM_API_BASE",
    listable: true,
    defaultBase: "https://integrate.api.nvidia.com/v1",
  }),
  p({
    id: "anyscale",
    label: "Anyscale",
    keyEnv: "ANYSCALE_API_KEY",
    baseEnv: "ANYSCALE_API_BASE",
  }),
  p({
    id: "deepinfra",
    label: "DeepInfra",
    keyEnv: "DEEPINFRA_API_KEY",
    keyHint: "A DeepInfra API token (deepinfra.com).",
    baseEnv: "DEEPINFRA_API_BASE",
    listable: true,
    defaultBase: "https://api.deepinfra.com/v1/openai",
  }),
  p({
    id: "ai21",
    label: "AI21",
    keyEnv: "AI21_API_KEY",
    keyHint: "An AI21 Studio API key (studio.ai21.com).",
    baseEnv: "AI21_API_BASE",
  }),
  p({
    id: "baseten",
    label: "Baseten",
    keyEnv: "BASETEN_API_KEY",
    baseEnv: "BASETEN_API_BASE",
  }),
  p({
    id: "sambanova",
    label: "SambaNova",
    keyEnv: "SAMBANOVA_API_KEY",
    keyHint: "A SambaNova Cloud API key (cloud.sambanova.ai).",
    baseEnv: "SAMBANOVA_API_BASE",
    listable: true,
    defaultBase: "https://api.sambanova.ai/v1",
  }),
  p({
    id: "volcengine",
    label: "Volcengine (Ark)",
    keyEnv: "VOLCENGINE_API_KEY",
    baseEnv: "VOLCENGINE_API_BASE",
  }),
  p({
    id: "tencent",
    label: "Tencent",
    keyEnv: "TENCENT_API_KEY",
    baseEnv: "TENCENT_API_BASE",
  }),
  p({
    id: "empower",
    label: "Empower",
    keyEnv: "EMPOWER_API_KEY",
    baseEnv: "EMPOWER_API_BASE",
  }),
  p({
    id: "friendliai",
    label: "FriendliAI",
    keyEnv: "FRIENDLIAI_API_KEY",
    baseEnv: "FRIENDLI_API_BASE",
  }),
  p({
    id: "galadriel",
    label: "Galadriel",
    keyEnv: "GALADRIEL_API_KEY",
    baseEnv: "GALADRIEL_API_BASE",
  }),
  p({
    id: "github",
    label: "GitHub Models",
    keyEnv: "GITHUB_API_KEY",
    keyPlaceholder: "ghp_… or github_pat_…",
    baseEnv: "GITHUB_API_BASE",
    hint: "A GitHub PAT with models access (not your repo token).",
  }),
  p({
    id: "meta_llama",
    label: "Meta Llama API",
    keyEnv: "LLAMA_API_KEY",
    baseEnv: "LLAMA_API_BASE",
  }),
  p({
    id: "nebius",
    label: "Nebius AI Studio",
    keyEnv: "NEBIUS_API_KEY",
    keyHint: "A Nebius AI Studio API key (studio.nebius.ai).",
    baseEnv: "NEBIUS_API_BASE",
    listable: true,
    defaultBase: "https://api.studio.nebius.ai/v1",
  }),
  p({
    id: "novita",
    label: "Novita AI",
    keyEnv: "NOVITA_API_KEY",
    keyPlaceholder: "sk_…",
    baseEnv: "NOVITA_API_BASE",
    listable: true,
    defaultBase: "https://api.novita.ai/v3/openai",
  }),
  p({
    id: "featherless_ai",
    label: "Featherless",
    keyEnv: "FEATHERLESS_AI_API_KEY",
    baseEnv: "FEATHERLESS_AI_API_BASE",
  }),
  p({
    id: "nscale",
    label: "Nscale",
    keyEnv: "NSCALE_API_KEY",
    baseEnv: "NSCALE_API_BASE",
  }),
  p({
    id: "dashscope",
    label: "Alibaba DashScope (Qwen)",
    keyEnv: "DASHSCOPE_API_KEY",
    keyPlaceholder: "sk-…",
    baseEnv: "DASHSCOPE_API_BASE",
    listable: true,
    defaultBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  }),
  p({
    id: "modelscope",
    label: "ModelScope",
    keyEnv: "MODELSCOPE_API_KEY",
    baseEnv: "MODELSCOPE_API_BASE",
  }),
  p({
    id: "v0",
    label: "v0 (Vercel)",
    keyEnv: "V0_API_KEY",
    keyHint: "A v0 API key from v0.dev.",
    baseEnv: "V0_API_BASE",
  }),
  p({
    id: "morph",
    label: "Morph",
    keyEnv: "MORPH_API_KEY",
    baseEnv: "MORPH_API_BASE",
  }),
  p({
    id: "lambda_ai",
    label: "Lambda",
    keyEnv: "LAMBDA_API_KEY",
    keyPlaceholder: "secret_…",
    baseEnv: "LAMBDA_API_BASE",
    listable: true,
    defaultBase: "https://api.lambda.ai/v1",
  }),
  p({
    id: "inception",
    label: "Inception",
    keyEnv: "INCEPTION_API_KEY",
    baseEnv: "INCEPTION_API_BASE",
  }),
  p({
    id: "hyperbolic",
    label: "Hyperbolic",
    keyEnv: "HYPERBOLIC_API_KEY",
    keyHint: "A Hyperbolic API key (app.hyperbolic.xyz).",
    baseEnv: "HYPERBOLIC_API_BASE",
    listable: true,
    defaultBase: "https://api.hyperbolic.xyz/v1",
  }),
  p({
    id: "aiml",
    label: "AI/ML API",
    keyEnv: "AIML_API_KEY",
    baseEnv: "AIML_API_BASE",
  }),
  p({
    id: "wandb",
    label: "W&B Inference",
    keyEnv: "WANDB_API_KEY",
    keyHint: "Your Weights & Biases API key (wandb.ai/authorize).",
    baseEnv: "WANDB_API_BASE",
  }),
  p({
    id: "cometapi",
    label: "CometAPI",
    keyEnv: "COMETAPI_KEY",
    baseEnv: "COMETAPI_API_BASE",
  }),
  p({
    id: "clarifai",
    label: "Clarifai",
    keyEnv: "CLARIFAI_API_KEY",
    baseEnv: "CLARIFAI_API_BASE",
    hint: "A Clarifai PAT.",
  }),
  p({
    id: "zai",
    label: "Z.AI (GLM)",
    keyEnv: "ZAI_API_KEY",
    baseEnv: "ZAI_API_BASE",
  }),
  p({
    id: "minimax",
    label: "MiniMax",
    keyEnv: "MINIMAX_API_KEY",
    baseEnv: "MINIMAX_API_BASE",
  }),
  p({
    id: "gradient_ai",
    label: "DigitalOcean Gradient",
    keyEnv: "GRADIENT_AI_API_KEY",
    keyHint: "A DigitalOcean Gradient model-access key.",
    baseEnv: "GRADIENT_AI_API_BASE",
  }),
  p({
    id: "huggingface",
    label: "Hugging Face",
    keyEnv: "HF_TOKEN",
    keyPlaceholder: "hf_…",
    baseEnv: "HF_API_BASE",
    listable: true,
    defaultBase: "https://router.huggingface.co/v1",
  }),
  p({
    id: "datarobot",
    label: "DataRobot",
    keyEnv: "DATAROBOT_API_TOKEN",
    baseEnv: "DATAROBOT_ENDPOINT",
  }),
  p({
    id: "vercel_ai_gateway",
    label: "Vercel AI Gateway",
    keyEnv: "VERCEL_AI_GATEWAY_API_KEY",
    keyHint: "A Vercel AI Gateway key (the AI tab of your Vercel dashboard).",
    baseEnv: "VERCEL_AI_GATEWAY_API_BASE",
  }),

  // ── Gateways and self-hosted backends (endpoint required) ─────────────────
  p({
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    keyEnv: "CLOUDFLARE_API_KEY",
    baseEnv: "CLOUDFLARE_API_BASE",
    needsBase: true,
    hint: "Endpoint: https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1",
  }),
  p({
    id: "databricks",
    label: "Databricks",
    keyEnv: "DATABRICKS_API_KEY",
    baseEnv: "DATABRICKS_API_BASE",
    needsBase: true,
    listable: true,
    hint: "Endpoint: https://<workspace>/serving-endpoints",
  }),
  p({
    id: "azure_ai",
    label: "Azure AI Foundry",
    keyEnv: "AZURE_AI_API_KEY",
    baseEnv: "AZURE_AI_API_BASE",
    basePlaceholder: "https://<resource>.services.ai.azure.com/models",
    needsBase: true,
  }),
  p({
    id: "litellm_proxy",
    label: "litellm proxy",
    keyEnv: "LITELLM_PROXY_API_KEY",
    baseEnv: "LITELLM_PROXY_API_BASE",
    basePlaceholder: "http://localhost:4000",
    needsBase: true,
    listable: true,
  }),
  p({
    id: "heroku",
    label: "Heroku Inference",
    keyEnv: "HEROKU_API_KEY",
    keyHint: "From the Heroku Inference add-on's config vars.",
    baseEnv: "HEROKU_API_BASE",
    needsBase: true,
  }),
  p({
    id: "ovhcloud",
    label: "OVHcloud AI Endpoints",
    keyEnv: "OVHCLOUD_API_KEY",
    baseEnv: "OVHCLOUD_API_BASE",
  }),
  p({
    id: "hosted_vllm",
    label: "vLLM (self-hosted)",
    keyEnv: "HOSTED_VLLM_API_KEY",
    baseEnv: "HOSTED_VLLM_API_BASE",
    basePlaceholder: "http://localhost:8000/v1",
    needsBase: true,
    keyOptional: true,
    listable: true,
  }),
  p({
    id: "llamafile",
    label: "llamafile",
    keyEnv: "LLAMAFILE_API_KEY",
    baseEnv: "LLAMAFILE_API_BASE",
    basePlaceholder: "http://localhost:8080/v1",
    needsBase: true,
    keyOptional: true,
    listable: true,
  }),
  p({
    id: "lm_studio",
    label: "LM Studio",
    keyEnv: "LM_STUDIO_API_KEY",
    baseEnv: "LM_STUDIO_API_BASE",
    basePlaceholder: "http://localhost:1234/v1",
    needsBase: true,
    keyOptional: true,
    listable: true,
  }),
  p({
    id: "docker_model_runner",
    label: "Docker Model Runner",
    keyEnv: "DOCKER_MODEL_RUNNER_API_KEY",
    baseEnv: "DOCKER_MODEL_RUNNER_API_BASE",
    basePlaceholder: "http://localhost:12434/engines/v1",
    needsBase: true,
    keyOptional: true,
    listable: true,
  }),
  p({
    id: "lemonade",
    label: "AMD Lemonade",
    keyEnv: "LEMONADE_API_KEY",
    baseEnv: "LEMONADE_API_BASE",
    basePlaceholder: "http://localhost:8000/api/v1",
    needsBase: true,
    keyOptional: true,
  }),
  p({
    id: "xinference",
    label: "Xinference",
    keyEnv: "XINFERENCE_API_KEY",
    baseEnv: "XINFERENCE_API_BASE",
    basePlaceholder: "http://localhost:9997/v1",
    needsBase: true,
    keyOptional: true,
  }),
  p({
    id: "ragflow",
    label: "RAGFlow",
    keyEnv: "RAGFLOW_API_KEY",
    baseEnv: "RAGFLOW_API_BASE",
    basePlaceholder: "http://localhost:9380/api/v1",
    needsBase: true,
    keyOptional: true,
  }),
  p({
    id: "oobabooga",
    label: "text-generation-webui",
    keyEnv: "OOBABOOGA_API_KEY",
    baseEnv: "OOBABOOGA_API_BASE",
    basePlaceholder: "http://localhost:5000/v1",
    needsBase: true,
    keyOptional: true,
  }),
  p({
    id: "openai_like",
    label: "Custom OpenAI-compatible",
    keyEnv: "OPENAI_LIKE_API_KEY",
    baseEnv: "OPENAI_LIKE_API_BASE",
    needsBase: true,
    keyOptional: true,
    listable: true,
    hint: "Any endpoint that speaks /chat/completions.",
  }),
  p({ id: "maritalk", label: "MariTalk", keyEnv: "MARITALK_API_KEY" }),

  // ── litellm's JSON-configured gateways ────────────────────────────────────
  p({
    id: "publicai",
    label: "PublicAI",
    keyEnv: "PUBLICAI_API_KEY",
    baseEnv: "PUBLICAI_API_BASE",
  }),
  p({
    id: "helicone",
    label: "Helicone AI Gateway",
    keyEnv: "HELICONE_API_KEY",
  }),
  p({ id: "veniceai", label: "Venice AI", keyEnv: "VENICE_AI_API_KEY" }),
  p({ id: "xiaomi_mimo", label: "Xiaomi MiMo", keyEnv: "XIAOMI_MIMO_API_KEY" }),
  p({
    id: "scaleway",
    label: "Scaleway",
    keyEnv: "SCW_SECRET_KEY",
    keyHint: "Your Scaleway secret key (a UUID).",
  }),
  p({ id: "synthetic", label: "Synthetic", keyEnv: "SYNTHETIC_API_KEY" }),
  p({ id: "apertis", label: "Apertis (Stima)", keyEnv: "STIMA_API_KEY" }),
  p({ id: "nano-gpt", label: "Nano-GPT", keyEnv: "NANOGPT_API_KEY" }),
  p({
    id: "poe",
    label: "Poe",
    keyEnv: "POE_API_KEY",
    keyHint: "A Poe API key (poe.com/api_key).",
  }),
  p({ id: "chutes", label: "Chutes", keyEnv: "CHUTES_API_KEY" }),
  p({
    id: "abliteration",
    label: "Abliteration",
    keyEnv: "ABLITERATION_API_KEY",
  }),
  p({ id: "llamagate", label: "LlamaGate", keyEnv: "LLAMAGATE_API_KEY" }),
  p({ id: "gmi", label: "GMI Cloud", keyEnv: "GMI_API_KEY" }),
  p({ id: "sarvam", label: "Sarvam AI", keyEnv: "SARVAM_API_KEY" }),
  p({
    id: "assemblyai",
    label: "AssemblyAI LLM Gateway",
    keyEnv: "ASSEMBLYAI_API_KEY",
  }),
  p({
    id: "charity_engine",
    label: "Charity Engine",
    keyEnv: "CHARITY_ENGINE_API_KEY",
  }),
  p({
    id: "aihubmix",
    label: "AIHubMix",
    keyEnv: "AIHUBMIX_API_KEY",
    baseEnv: "AIHUBMIX_API_BASE",
  }),
  p({
    id: "crusoe",
    label: "Crusoe",
    keyEnv: "CRUSOE_API_KEY",
    baseEnv: "CRUSOE_API_BASE",
  }),
  p({
    id: "darkbloom",
    label: "Darkbloom",
    keyEnv: "DARKBLOOM_API_KEY",
    baseEnv: "DARKBLOOM_API_BASE",
  }),
  p({
    id: "neosantara",
    label: "Neosantara",
    keyEnv: "NEOSANTARA_API_KEY",
    baseEnv: "NEOSANTARA_API_BASE",
  }),
  p({
    id: "tensormesh",
    label: "Tensormesh",
    keyEnv: "TENSORMESH_INFERENCE_API_KEY",
    baseEnv: "TENSORMESH_SERVERLESS_BASE_URL",
  }),
  p({
    id: "parasail",
    label: "Parasail",
    keyEnv: "PARASAIL_API_KEY",
    baseEnv: "PARASAIL_API_BASE",
  }),
  p({
    id: "libertai",
    label: "LibertAI",
    keyEnv: "LIBERTAI_API_KEY",
    baseEnv: "LIBERTAI_API_BASE",
  }),
  p({
    id: "empiriolabs",
    label: "Empirio Labs",
    keyEnv: "EMPIRIOLABS_API_KEY",
    baseEnv: "EMPIRIOLABS_API_BASE",
  }),
  p({
    id: "pinstripes",
    label: "Pinstripes",
    keyEnv: "PINSTRIPES_API_KEY",
    baseEnv: "PINSTRIPES_API_BASE",
  }),

  // ── Bespoke-auth providers (dedicated gollm adapters) ─────────────────────
  p({
    id: "github_copilot",
    label: "GitHub Copilot (subscription)",
    subscription: true,
    fields: [
      secret("GITHUB_COPILOT_ACCESS_TOKEN", "GitHub OAuth token", {
        role: "key",
        placeholder: "gho_…",
        hint: "A GitHub OAuth token with Copilot access — not your repo token. The Copilot session token is minted per run.",
      }),
    ],
  }),
  p({
    id: "replicate",
    label: "Replicate",
    fields: [
      secret("REPLICATE_API_TOKEN", "API token", {
        role: "key",
        placeholder: "r8_…",
      }),
    ],
    hint: "Text chat only — Replicate has no tool-calling surface.",
  }),
  p({
    id: "watsonx",
    label: "IBM watsonx.ai",
    listable: false,
    fields: [
      secret("WATSONX_APIKEY", "IBM Cloud API key", {
        role: "key",
        hint: "An IBM Cloud API key (IBM Cloud → Manage → Access → API keys).",
      }),
      text("WATSONX_URL", "Service URL", {
        role: "base",
        placeholder: "https://us-south.ml.cloud.ibm.com",
      }),
      text("WATSONX_PROJECT_ID", "Project ID", {
        placeholder: "01234567-89ab-cdef-0123-456789abcdef",
      }),
    ],
  }),
  p({
    id: "snowflake",
    label: "Snowflake Cortex",
    fields: [
      secret("SNOWFLAKE_JWT", "Key-pair JWT or PAT", {
        role: "key",
        placeholder: "<jwt> or pat/<token>",
        hint: 'A key-pair JWT, or a programmatic access token prefixed with "pat/".',
      }),
      text("SNOWFLAKE_ACCOUNT_ID", "Account identifier", {
        placeholder: "myorg-myaccount",
      }),
    ],
  }),
  p({
    id: "gigachat",
    label: "Sber GigaChat",
    fields: [
      secret("GIGACHAT_CREDENTIALS", "Authorization key (base64)", {
        role: "key",
        hint: "The base64 authorization key from the developer portal. The pod must trust Sber's Russian Trusted Root CA.",
      }),
    ],
  }),
  p({
    id: "oci",
    label: "OCI Generative AI",
    fields: [
      secret("OCI_KEY", "API private key (PEM)", {
        role: "key",
        kind: "textarea",
        placeholder: "-----BEGIN PRIVATE KEY-----\n…",
      }),
      text("OCI_USER", "User OCID", { placeholder: "ocid1.user.oc1..…" }),
      text("OCI_FINGERPRINT", "Key fingerprint", {
        placeholder: "aa:bb:cc:…",
      }),
      text("OCI_TENANCY", "Tenancy OCID", {
        placeholder: "ocid1.tenancy.oc1..…",
      }),
      text("OCI_COMPARTMENT_ID", "Compartment OCID", {
        placeholder: "ocid1.compartment.oc1..…",
      }),
      text("OCI_REGION", "Region", {
        optional: true,
        placeholder: "us-ashburn-1",
      }),
    ],
  }),
  p({
    id: "sagemaker",
    label: "Amazon SageMaker",
    // No bearer key — AWS SigV4 over the three fields. The model id is the
    // inference endpoint name (Messages-API containers).
    fields: [
      text("AWS_ACCESS_KEY_ID", "AWS access key ID", {
        placeholder: "AKIA…",
      }),
      secret("AWS_SECRET_ACCESS_KEY", "AWS secret access key"),
      text("AWS_REGION", "AWS region", { placeholder: "us-east-1" }),
    ],
  }),
  p({
    id: "triton",
    label: "NVIDIA Triton",
    fields: [
      text("TRITON_API_BASE", "Server endpoint", {
        role: "base",
        placeholder: "http://triton:8000",
      }),
      secret("TRITON_API_KEY", "API key", { role: "key", optional: true }),
    ],
  }),
  p({
    id: "predibase",
    label: "Predibase",
    fields: [
      secret("PREDIBASE_API_KEY", "API key", {
        role: "key",
        hint: "A Predibase API token (Settings → My profile).",
      }),
      text("PREDIBASE_TENANT_ID", "Tenant ID", { placeholder: "abc123" }),
    ],
  }),
  p({ id: "nlp_cloud", label: "NLP Cloud", keyEnv: "NLP_CLOUD_API_KEY" }),
  p({
    id: "petals",
    label: "Petals swarm",
    fields: [
      text("PETALS_API_BASE", "Swarm endpoint", {
        role: "base",
        optional: true,
        placeholder: "https://chat.petals.dev/api/v1/generate",
      }),
      secret("PETALS_API_KEY", "API key", { role: "key", optional: true }),
    ],
  }),
  p({ id: "bytez", label: "Bytez", keyEnv: "BYTEZ_API_KEY" }),
];

const byId = new Map(GOLLM_PROVIDERS.map((info) => [info.id, info]));

/** Looks up a catalog entry by gollm provider id. */
export function gollmProviderInfo(id: string): GollmProviderInfo | undefined {
  return byId.get(id);
}

/**
 * Discoverability weight for the settings provider directory. The widely-used
 * providers float to the top of the (otherwise alphabetical) unconfigured list,
 * the way the four first-class providers do with their 70–100 weights, instead
 * of being lost among the ~90-entry long tail. Kept well below the first-class
 * band so they never outrank Anthropic/OpenAI/Gemini/Bedrock. Default 0.
 */
const PROVIDER_PRIORITY: Record<string, number> = {
  groq: 20,
  openrouter: 20,
  together: 18,
  deepseek: 18,
  xai: 18,
  mistral: 16,
  fireworks: 14,
  perplexity: 14,
  huggingface: 14,
  cerebras: 12,
  moonshot: 12,
  nvidia: 12,
  openai_like: 10,
  hosted_vllm: 10,
  lm_studio: 10,
};

/** The directory discoverability weight for a provider (0 when not curated). */
export function providerPriority(id: string): number {
  return PROVIDER_PRIORITY[id] ?? 0;
}

/**
 * The credential fields a provider's form renders: its explicit `fields` when
 * declared, else a clean form derived from keyEnv/baseEnv — the API key (and,
 * for self-hosted backends, the endpoint), in the order the provider expects
 * (endpoint first when it's required). This is the single source of the
 * bespoke form shape; the settings UI, validation, and env packing all read it.
 */
export function providerFields(info: GollmProviderInfo): CredentialField[] {
  if (info.fields) return info.fields;

  const keyF: CredentialField | null = info.keyEnv
    ? {
        env: info.keyEnv,
        label: "API key",
        kind: "secret",
        role: "key",
        optional: info.keyOptional,
        placeholder: info.keyPlaceholder,
        hint: info.keyHint,
      }
    : null;
  const baseF: CredentialField | null = info.baseEnv
    ? {
        env: info.baseEnv,
        label: "Endpoint URL",
        kind: "text",
        role: "base",
        optional: !info.needsBase,
        placeholder: info.basePlaceholder,
      }
    : null;

  // Self-hosted backends (endpoint required) lead with the endpoint; hosted
  // ones lead with the key.
  const ordered =
    info.needsBase && baseF && keyF ? [baseF, keyF] : [keyF, baseF];
  return ordered.filter((f): f is CredentialField => f !== null);
}

/** The provider's bearer-key field (role "key"), if any. */
export function keyFieldOf(
  info: GollmProviderInfo,
): CredentialField | undefined {
  return providerFields(info).find((f) => f.role === "key");
}

/** The provider's endpoint field (role "base"), if any. */
export function baseFieldOf(
  info: GollmProviderInfo,
): CredentialField | undefined {
  return providerFields(info).find((f) => f.role === "base");
}

/** The `gollm:`-prefixed provider name used on ModelOption / modelProvider. */
export function gollmProviderName(id: string): `gollm:${string}` {
  return `gollm:${id}`;
}

/** Extracts the gollm provider id from a `gollm:<id>` provider name. */
export function parseGollmProvider(provider: string): string | null {
  return provider.startsWith("gollm:") ? provider.slice("gollm:".length) : null;
}

/**
 * Maps a stored custom-provider credential onto the env vars gollm reads in
 * the pod: the key and endpoint under the provider's conventional names, plus
 * any extra env verbatim. Empty values are dropped.
 */
export function gollmProviderEnv(cred: {
  provider: string;
  apiKey: string | null;
  apiBase: string | null;
  extraEnv: Record<string, string> | null;
}): Record<string, string> {
  const info = byId.get(cred.provider);
  const env: Record<string, string> = {};
  const keyEnv = info ? keyFieldOf(info)?.env : undefined;
  const baseEnv = info ? baseFieldOf(info)?.env : undefined;
  if (keyEnv && cred.apiKey) env[keyEnv] = cred.apiKey;
  if (baseEnv && cred.apiBase) env[baseEnv] = cred.apiBase;
  for (const [k, v] of Object.entries(cred.extraEnv ?? {})) {
    if (k && v) env[k] = v;
  }
  return env;
}
