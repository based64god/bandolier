// Package compat registers the OpenAI-compatible providers (groq, mistral,
// deepseek, ...) as thin parameterizations of the openai adapter. Each entry
// differs only in endpoint, credential env vars, and two capability quirks:
// whether the backend tolerates stream_options and whether it serves an
// /embeddings endpoint. Import this package for its side effects.
//
// The table mirrors litellm's OpenAI-compatible provider roster (its
// openai_compatible_providers list plus the JSON-configured entries in
// litellm/llms/openai_like/providers.json); base URLs and env var names are
// taken from the litellm source so litellm-style configs and environments
// drop in. litellm providers that need a bespoke wire protocol or auth
// scheme are NOT here — anthropic, bedrock, sagemaker, vertex, gemini,
// azure, cohere, ollama, chatgpt, github_copilot, replicate, watsonx,
// snowflake, gigachat, oci, triton, predibase, nlp_cloud, petals, and bytez
// each have a dedicated gollm adapter.
package compat

import (
	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/providers/openai"
)

// placeholderKey is sent to keyless local backends (llamafile, LM Studio,
// vLLM, ...); litellm sends the same kind of stand-in.
const placeholderKey = "fake-api-key"

// defaults is the compat provider table. Env vars are checked in order;
// secondary spellings (TOGETHERAI_API_KEY, ...) mirror litellm's accepted
// variants.
var defaults = []openai.Defaults{
	// ── Hosted inference clouds and model vendors ─────────────────────────────
	{
		Name:                   "groq",
		BaseURL:                "https://api.groq.com/openai/v1",
		APIKeyEnvs:             []string{"GROQ_API_KEY"},
		StreamOptionsSupported: true,
	},
	{
		Name:                "mistral",
		BaseURL:             "https://api.mistral.ai/v1",
		BaseURLEnvs:         []string{"MISTRAL_API_BASE"},
		APIKeyEnvs:          []string{"MISTRAL_API_KEY"},
		EmbeddingsSupported: true,
	},
	{
		// Mistral's dedicated code-model endpoint (chat side; FIM is not part
		// of the unified format).
		Name:        "codestral",
		BaseURL:     "https://codestral.mistral.ai/v1",
		BaseURLEnvs: []string{"CODESTRAL_API_BASE"},
		APIKeyEnvs:  []string{"CODESTRAL_API_KEY"},
	},
	{
		Name:                   "deepseek",
		BaseURL:                "https://api.deepseek.com/v1",
		BaseURLEnvs:            []string{"DEEPSEEK_API_BASE"},
		APIKeyEnvs:             []string{"DEEPSEEK_API_KEY"},
		StreamOptionsSupported: true,
	},
	{
		Name:                   "xai",
		BaseURL:                "https://api.x.ai/v1",
		APIKeyEnvs:             []string{"XAI_API_KEY"},
		StreamOptionsSupported: true,
	},
	{
		Name:                "together",
		BaseURL:             "https://api.together.xyz/v1",
		BaseURLEnvs:         []string{"TOGETHER_AI_API_BASE"},
		APIKeyEnvs:          []string{"TOGETHER_API_KEY", "TOGETHERAI_API_KEY", "TOGETHER_AI_API_KEY", "TOGETHER_AI_TOKEN"},
		EmbeddingsSupported: true,
	},
	{
		Name:                "fireworks",
		BaseURL:             "https://api.fireworks.ai/inference/v1",
		APIKeyEnvs:          []string{"FIREWORKS_API_KEY", "FIREWORKS_AI_API_KEY"},
		EmbeddingsSupported: true,
	},
	{
		// Perplexity serves /chat/completions at the bare host (no /v1).
		Name:       "perplexity",
		BaseURL:    "https://api.perplexity.ai",
		APIKeyEnvs: []string{"PERPLEXITY_API_KEY", "PERPLEXITYAI_API_KEY"},
	},
	{
		Name:        "cerebras",
		BaseURL:     "https://api.cerebras.ai/v1",
		BaseURLEnvs: []string{"CEREBRAS_API_BASE"},
		APIKeyEnvs:  []string{"CEREBRAS_API_KEY"},
	},
	{
		Name:        "moonshot",
		BaseURL:     "https://api.moonshot.ai/v1",
		BaseURLEnvs: []string{"MOONSHOT_API_BASE"},
		APIKeyEnvs:  []string{"MOONSHOT_API_KEY"},
	},
	{
		Name:        "nvidia",
		BaseURL:     "https://integrate.api.nvidia.com/v1",
		BaseURLEnvs: []string{"NVIDIA_NIM_API_BASE"},
		APIKeyEnvs:  []string{"NVIDIA_NIM_API_KEY", "NVIDIA_API_KEY"},
	},
	{
		Name:        "anyscale",
		BaseURL:     "https://api.endpoints.anyscale.com/v1",
		BaseURLEnvs: []string{"ANYSCALE_API_BASE"},
		APIKeyEnvs:  []string{"ANYSCALE_API_KEY"},
	},
	{
		Name:                "deepinfra",
		BaseURL:             "https://api.deepinfra.com/v1/openai",
		BaseURLEnvs:         []string{"DEEPINFRA_API_BASE"},
		APIKeyEnvs:          []string{"DEEPINFRA_API_KEY"},
		EmbeddingsSupported: true,
	},
	{
		Name:        "ai21",
		BaseURL:     "https://api.ai21.com/studio/v1",
		BaseURLEnvs: []string{"AI21_API_BASE"},
		APIKeyEnvs:  []string{"AI21_API_KEY"},
	},
	{
		Name:        "baseten",
		BaseURL:     "https://inference.baseten.co/v1",
		BaseURLEnvs: []string{"BASETEN_API_BASE"},
		APIKeyEnvs:  []string{"BASETEN_API_KEY"},
	},
	{
		Name:        "sambanova",
		BaseURL:     "https://api.sambanova.ai/v1",
		BaseURLEnvs: []string{"SAMBANOVA_API_BASE"},
		APIKeyEnvs:  []string{"SAMBANOVA_API_KEY"},
	},
	{
		Name:        "volcengine",
		BaseURL:     "https://ark.cn-beijing.volces.com/api/v3",
		BaseURLEnvs: []string{"VOLCENGINE_API_BASE"},
		APIKeyEnvs:  []string{"VOLCENGINE_API_KEY"},
	},
	{
		Name:        "tencent",
		BaseURL:     "https://tokenhub-intl.tencentcloudmaas.com/v1",
		BaseURLEnvs: []string{"TENCENT_API_BASE"},
		APIKeyEnvs:  []string{"TENCENT_API_KEY"},
	},
	{
		Name:        "empower",
		BaseURL:     "https://app.empower.dev/api/v1",
		BaseURLEnvs: []string{"EMPOWER_API_BASE"},
		APIKeyEnvs:  []string{"EMPOWER_API_KEY"},
	},
	{
		Name:        "friendliai",
		BaseURL:     "https://api.friendli.ai/serverless/v1",
		BaseURLEnvs: []string{"FRIENDLI_API_BASE"},
		APIKeyEnvs:  []string{"FRIENDLIAI_API_KEY", "FRIENDLI_TOKEN"},
	},
	{
		Name:        "galadriel",
		BaseURL:     "https://api.galadriel.com/v1",
		BaseURLEnvs: []string{"GALADRIEL_API_BASE"},
		APIKeyEnvs:  []string{"GALADRIEL_API_KEY"},
	},
	{
		// GitHub Models (marketplace inference; not Copilot).
		Name:        "github",
		BaseURL:     "https://models.inference.ai.azure.com",
		BaseURLEnvs: []string{"GITHUB_API_BASE"},
		APIKeyEnvs:  []string{"GITHUB_API_KEY"},
	},
	{
		Name:        "meta_llama",
		BaseURL:     "https://api.llama.com/compat/v1",
		BaseURLEnvs: []string{"LLAMA_API_BASE"},
		APIKeyEnvs:  []string{"LLAMA_API_KEY"},
	},
	{
		Name:                "nebius",
		BaseURL:             "https://api.studio.nebius.ai/v1",
		BaseURLEnvs:         []string{"NEBIUS_API_BASE"},
		APIKeyEnvs:          []string{"NEBIUS_API_KEY"},
		EmbeddingsSupported: true,
	},
	{
		Name:        "novita",
		BaseURL:     "https://api.novita.ai/v3/openai",
		BaseURLEnvs: []string{"NOVITA_API_BASE"},
		APIKeyEnvs:  []string{"NOVITA_API_KEY"},
	},
	{
		Name:        "featherless_ai",
		BaseURL:     "https://api.featherless.ai/v1",
		BaseURLEnvs: []string{"FEATHERLESS_AI_API_BASE"},
		APIKeyEnvs:  []string{"FEATHERLESS_AI_API_KEY"},
	},
	{
		Name:        "nscale",
		BaseURL:     "https://inference.api.nscale.com/v1",
		BaseURLEnvs: []string{"NSCALE_API_BASE"},
		APIKeyEnvs:  []string{"NSCALE_API_KEY"},
	},
	{
		// Alibaba Qwen (international endpoint via DASHSCOPE_API_BASE).
		Name:        "dashscope",
		BaseURL:     "https://dashscope.aliyuncs.com/compatible-mode/v1",
		BaseURLEnvs: []string{"DASHSCOPE_API_BASE"},
		APIKeyEnvs:  []string{"DASHSCOPE_API_KEY"},
	},
	{
		Name:        "modelscope",
		BaseURL:     "https://api-inference.modelscope.cn/v1",
		BaseURLEnvs: []string{"MODELSCOPE_API_BASE"},
		APIKeyEnvs:  []string{"MODELSCOPE_API_KEY"},
	},
	{
		Name:        "v0",
		BaseURL:     "https://api.v0.dev/v1",
		BaseURLEnvs: []string{"V0_API_BASE"},
		APIKeyEnvs:  []string{"V0_API_KEY"},
	},
	{
		Name:        "morph",
		BaseURL:     "https://api.morphllm.com/v1",
		BaseURLEnvs: []string{"MORPH_API_BASE"},
		APIKeyEnvs:  []string{"MORPH_API_KEY"},
	},
	{
		Name:        "lambda_ai",
		BaseURL:     "https://api.lambda.ai/v1",
		BaseURLEnvs: []string{"LAMBDA_API_BASE"},
		APIKeyEnvs:  []string{"LAMBDA_API_KEY"},
	},
	{
		Name:        "inception",
		BaseURL:     "https://api.inceptionlabs.ai/v1",
		BaseURLEnvs: []string{"INCEPTION_API_BASE"},
		APIKeyEnvs:  []string{"INCEPTION_API_KEY"},
	},
	{
		Name:        "hyperbolic",
		BaseURL:     "https://api.hyperbolic.xyz/v1",
		BaseURLEnvs: []string{"HYPERBOLIC_API_BASE"},
		APIKeyEnvs:  []string{"HYPERBOLIC_API_KEY"},
	},
	{
		Name:        "aiml",
		BaseURL:     "https://api.aimlapi.com/v1",
		BaseURLEnvs: []string{"AIML_API_BASE"},
		APIKeyEnvs:  []string{"AIML_API_KEY"},
	},
	{
		Name:        "wandb",
		BaseURL:     "https://api.inference.wandb.ai/v1",
		BaseURLEnvs: []string{"WANDB_API_BASE"},
		APIKeyEnvs:  []string{"WANDB_API_KEY"},
	},
	{
		Name:        "cometapi",
		BaseURL:     "https://api.cometapi.com/v1",
		BaseURLEnvs: []string{"COMETAPI_API_BASE"},
		APIKeyEnvs:  []string{"COMETAPI_KEY", "COMETAPI_API_KEY"},
	},
	{
		// Clarifai's OpenAI-compatible extension endpoint; the key is a
		// Clarifai PAT.
		Name:        "clarifai",
		BaseURL:     "https://api.clarifai.com/v2/ext/openai/v1",
		BaseURLEnvs: []string{"CLARIFAI_API_BASE"},
		APIKeyEnvs:  []string{"CLARIFAI_API_KEY", "CLARIFAI_PAT"},
	},
	{
		// Z.AI (GLM models).
		Name:        "zai",
		BaseURL:     "https://api.z.ai/api/paas/v4",
		BaseURLEnvs: []string{"ZAI_API_BASE"},
		APIKeyEnvs:  []string{"ZAI_API_KEY"},
	},
	{
		Name:        "minimax",
		BaseURL:     "https://api.minimax.io/v1",
		BaseURLEnvs: []string{"MINIMAX_API_BASE"},
		APIKeyEnvs:  []string{"MINIMAX_API_KEY"},
	},
	{
		// DigitalOcean Gradient AI.
		Name:        "gradient_ai",
		BaseURL:     "https://inference.do-ai.run/v1",
		BaseURLEnvs: []string{"GRADIENT_AI_API_BASE", "GRADIENT_AI_AGENT_ENDPOINT"},
		APIKeyEnvs:  []string{"GRADIENT_AI_API_KEY", "DIGITALOCEAN_API_KEY"},
	},
	{
		// Hugging Face Inference Providers router.
		Name:        "huggingface",
		BaseURL:     "https://router.huggingface.co/v1",
		BaseURLEnvs: []string{"HF_API_BASE", "HUGGINGFACE_API_BASE"},
		APIKeyEnvs:  []string{"HF_TOKEN", "HUGGINGFACE_API_KEY", "HF_API_KEY"},
	},
	{
		// DataRobot's LLM gateway. A dedicated-deployment URL can be supplied
		// via DATAROBOT_ENDPOINT instead.
		Name:        "datarobot",
		BaseURL:     "https://app.datarobot.com/api/v2/genai/llmgw",
		BaseURLEnvs: []string{"DATAROBOT_ENDPOINT"},
		APIKeyEnvs:  []string{"DATAROBOT_API_TOKEN", "DATAROBOT_API_KEY"},
	},
	{
		Name:       "openrouter",
		BaseURL:    "https://openrouter.ai/api/v1",
		APIKeyEnvs: []string{"OPENROUTER_API_KEY"},

		StreamOptionsSupported: true,
	},
	{
		Name:        "vercel_ai_gateway",
		BaseURL:     "https://ai-gateway.vercel.sh/v1",
		BaseURLEnvs: []string{"VERCEL_AI_GATEWAY_API_BASE"},
		APIKeyEnvs:  []string{"VERCEL_AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"},
	},

	// ── Gateways and self-hosted backends (endpoint from the environment) ─────
	{
		// Bearer token = a Cloudflare API token; the account-scoped compat
		// endpoint (https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1)
		// must be supplied since it embeds the account id.
		Name:        "cloudflare",
		BaseURLEnvs: []string{"CLOUDFLARE_API_BASE"},
		APIKeyEnvs:  []string{"CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN"},
	},
	{
		// Databricks Foundation Model API: base is
		// https://<workspace>/serving-endpoints.
		Name:        "databricks",
		BaseURLEnvs: []string{"DATABRICKS_API_BASE"},
		APIKeyEnvs:  []string{"DATABRICKS_API_KEY", "DATABRICKS_TOKEN"},
	},
	{
		// Azure AI Foundry serverless endpoints (OpenAI-compatible surface;
		// the azure provider handles Azure OpenAI deployments).
		Name:        "azure_ai",
		BaseURLEnvs: []string{"AZURE_AI_API_BASE"},
		APIKeyEnvs:  []string{"AZURE_AI_API_KEY"},
	},
	{
		Name:        "litellm_proxy",
		BaseURLEnvs: []string{"LITELLM_PROXY_API_BASE"},
		APIKeyEnvs:  []string{"LITELLM_PROXY_API_KEY"},
	},
	{
		Name:        "heroku",
		BaseURLEnvs: []string{"HEROKU_API_BASE"},
		APIKeyEnvs:  []string{"HEROKU_API_KEY"},
	},
	{
		Name:        "ovhcloud",
		BaseURL:     "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
		BaseURLEnvs: []string{"OVHCLOUD_API_BASE"},
		APIKeyEnvs:  []string{"OVHCLOUD_API_KEY"},
	},
	{
		// A vLLM server's OpenAI-compatible endpoint. litellm's bare `vllm/`
		// provider runs vLLM in-process via its Python SDK — no HTTP surface,
		// so it has no gollm equivalent; the `vllm` alias lands here. The
		// VLLM_* env spellings are accepted alongside litellm's HOSTED_VLLM_*.
		Name:                   "hosted_vllm",
		BaseURLEnvs:            []string{"HOSTED_VLLM_API_BASE", "VLLM_API_BASE"},
		APIKeyEnvs:             []string{"HOSTED_VLLM_API_KEY", "VLLM_API_KEY"},
		DefaultAPIKey:          placeholderKey,
		StreamOptionsSupported: true,
	},
	{
		Name:          "llamafile",
		BaseURL:       "http://127.0.0.1:8080/v1",
		BaseURLEnvs:   []string{"LLAMAFILE_API_BASE"},
		APIKeyEnvs:    []string{"LLAMAFILE_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		Name:          "lm_studio",
		BaseURL:       "http://localhost:1234/v1",
		BaseURLEnvs:   []string{"LM_STUDIO_API_BASE"},
		APIKeyEnvs:    []string{"LM_STUDIO_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		Name:          "docker_model_runner",
		BaseURL:       "http://model-runner.docker.internal/engines/llama.cpp/v1",
		BaseURLEnvs:   []string{"DOCKER_MODEL_RUNNER_API_BASE"},
		APIKeyEnvs:    []string{"DOCKER_MODEL_RUNNER_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		// AMD Lemonade (local).
		Name:          "lemonade",
		BaseURL:       "http://localhost:8000/api/v1",
		BaseURLEnvs:   []string{"LEMONADE_API_BASE"},
		APIKeyEnvs:    []string{"LEMONADE_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		Name:          "xinference",
		BaseURL:       "http://127.0.0.1:9997/v1",
		BaseURLEnvs:   []string{"XINFERENCE_API_BASE"},
		APIKeyEnvs:    []string{"XINFERENCE_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		Name:          "ragflow",
		BaseURLEnvs:   []string{"RAGFLOW_API_BASE"},
		APIKeyEnvs:    []string{"RAGFLOW_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		// text-generation-webui's built-in OpenAI-compatible API.
		Name:          "oobabooga",
		BaseURL:       "http://127.0.0.1:5000/v1",
		BaseURLEnvs:   []string{"OOBABOOGA_API_BASE"},
		APIKeyEnvs:    []string{"OOBABOOGA_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		// The fully generic escape hatch: any OpenAI-compatible endpoint,
		// named entirely by the environment (litellm's openai_like /
		// custom_openai).
		Name:          "openai_like",
		BaseURLEnvs:   []string{"OPENAI_LIKE_API_BASE"},
		APIKeyEnvs:    []string{"OPENAI_LIKE_API_KEY"},
		DefaultAPIKey: placeholderKey,
	},
	{
		Name:       "maritalk",
		BaseURL:    "https://chat.maritaca.ai/api",
		APIKeyEnvs: []string{"MARITALK_API_KEY", "MARITALK_API_TOKEN"},
	},

	// ── Embedding-only providers (chat calls will 404 at the backend) ─────────
	{
		Name:                "voyage",
		BaseURL:             "https://api.voyageai.com/v1",
		APIKeyEnvs:          []string{"VOYAGE_API_KEY"},
		EmbeddingsSupported: true,
	},
	{
		Name:                "jina_ai",
		BaseURL:             "https://api.jina.ai/v1",
		APIKeyEnvs:          []string{"JINA_AI_API_KEY", "JINA_API_KEY"},
		EmbeddingsSupported: true,
	},

	// ── JSON-configured litellm providers (litellm/llms/openai_like) ──────────
	{
		Name:        "publicai",
		BaseURL:     "https://api.publicai.co/v1",
		BaseURLEnvs: []string{"PUBLICAI_API_BASE"},
		APIKeyEnvs:  []string{"PUBLICAI_API_KEY"},
	},
	{
		Name:       "helicone",
		BaseURL:    "https://ai-gateway.helicone.ai",
		APIKeyEnvs: []string{"HELICONE_API_KEY"},
	},
	{
		Name:       "veniceai",
		BaseURL:    "https://api.venice.ai/api/v1",
		APIKeyEnvs: []string{"VENICE_AI_API_KEY"},
	},
	{
		Name:       "xiaomi_mimo",
		BaseURL:    "https://api.xiaomimimo.com/v1",
		APIKeyEnvs: []string{"XIAOMI_MIMO_API_KEY"},
	},
	{
		Name:       "scaleway",
		BaseURL:    "https://api.scaleway.ai/v1",
		APIKeyEnvs: []string{"SCW_SECRET_KEY", "SCALEWAY_API_KEY"},
	},
	{
		Name:       "synthetic",
		BaseURL:    "https://api.synthetic.new/openai/v1",
		APIKeyEnvs: []string{"SYNTHETIC_API_KEY"},
	},
	{
		// Stima Tech's gateway (litellm name: apertis).
		Name:       "apertis",
		BaseURL:    "https://api.stima.tech/v1",
		APIKeyEnvs: []string{"STIMA_API_KEY"},
	},
	{
		Name:       "nano-gpt",
		BaseURL:    "https://nano-gpt.com/api/v1",
		APIKeyEnvs: []string{"NANOGPT_API_KEY"},
	},
	{
		Name:       "poe",
		BaseURL:    "https://api.poe.com/v1",
		APIKeyEnvs: []string{"POE_API_KEY"},
	},
	{
		Name:       "chutes",
		BaseURL:    "https://llm.chutes.ai/v1",
		APIKeyEnvs: []string{"CHUTES_API_KEY"},
	},
	{
		Name:       "abliteration",
		BaseURL:    "https://api.abliteration.ai/v1",
		APIKeyEnvs: []string{"ABLITERATION_API_KEY"},
	},
	{
		Name:       "llamagate",
		BaseURL:    "https://api.llamagate.dev/v1",
		APIKeyEnvs: []string{"LLAMAGATE_API_KEY"},
	},
	{
		Name:       "gmi",
		BaseURL:    "https://api.gmi-serving.com/v1",
		APIKeyEnvs: []string{"GMI_API_KEY"},
	},
	{
		Name:       "sarvam",
		BaseURL:    "https://api.sarvam.ai/v1",
		APIKeyEnvs: []string{"SARVAM_API_KEY"},
	},
	{
		Name:       "assemblyai",
		BaseURL:    "https://llm-gateway.assemblyai.com/v1",
		APIKeyEnvs: []string{"ASSEMBLYAI_API_KEY"},
	},
	{
		Name:       "charity_engine",
		BaseURL:    "https://api.charityengine.services/remotejobs/v2/inference",
		APIKeyEnvs: []string{"CHARITY_ENGINE_API_KEY"},
	},
	{
		Name:        "aihubmix",
		BaseURL:     "https://aihubmix.com/v1",
		BaseURLEnvs: []string{"AIHUBMIX_API_BASE"},
		APIKeyEnvs:  []string{"AIHUBMIX_API_KEY"},
	},
	{
		Name:        "crusoe",
		BaseURL:     "https://managed-inference-api-proxy.crusoecloud.com/v1",
		BaseURLEnvs: []string{"CRUSOE_API_BASE"},
		APIKeyEnvs:  []string{"CRUSOE_API_KEY"},
	},
	{
		Name:        "darkbloom",
		BaseURL:     "https://api.darkbloom.dev/v1",
		BaseURLEnvs: []string{"DARKBLOOM_API_BASE"},
		APIKeyEnvs:  []string{"DARKBLOOM_API_KEY"},
	},
	{
		Name:        "neosantara",
		BaseURL:     "https://api.neosantara.xyz/v1",
		BaseURLEnvs: []string{"NEOSANTARA_API_BASE"},
		APIKeyEnvs:  []string{"NEOSANTARA_API_KEY"},
	},
	{
		Name:        "tensormesh",
		BaseURL:     "https://serverless.tensormesh.ai/v1",
		BaseURLEnvs: []string{"TENSORMESH_SERVERLESS_BASE_URL"},
		APIKeyEnvs:  []string{"TENSORMESH_INFERENCE_API_KEY", "TENSORMESH_API_KEY"},
	},
	{
		Name:        "parasail",
		BaseURL:     "https://api.parasail.io/v1",
		BaseURLEnvs: []string{"PARASAIL_API_BASE"},
		APIKeyEnvs:  []string{"PARASAIL_API_KEY"},
	},
	{
		Name:        "libertai",
		BaseURL:     "https://api.libertai.io/v1",
		BaseURLEnvs: []string{"LIBERTAI_API_BASE"},
		APIKeyEnvs:  []string{"LIBERTAI_API_KEY"},
	},
	{
		Name:        "empiriolabs",
		BaseURL:     "https://api.empiriolabs.ai/v1",
		BaseURLEnvs: []string{"EMPIRIOLABS_API_BASE"},
		APIKeyEnvs:  []string{"EMPIRIOLABS_API_KEY"},
	},
	{
		Name:        "pinstripes",
		BaseURL:     "https://pinstripes.io/v1",
		BaseURLEnvs: []string{"PINSTRIPES_API_BASE"},
		APIKeyEnvs:  []string{"PINSTRIPES_API_KEY"},
	},
}

// aliases maps alternate spellings (litellm names, vendor brands) onto
// canonical provider names.
var aliases = map[string]string{
	"mistralai":     "mistral",
	"x-ai":          "xai",
	"grok":          "xai",
	"together_ai":   "together",
	"togetherai":    "together",
	"fireworks_ai":  "fireworks",
	"kimi":          "moonshot",
	"nvidia_nim":    "nvidia",
	"ai21_chat":     "ai21",
	"lambda":        "lambda_ai",
	"meta-llama":    "meta_llama",
	"llama_api":     "meta_llama",
	"featherless":   "featherless_ai",
	"qwen":          "dashscope",
	"vercel":        "vercel_ai_gateway",
	"vllm":          "hosted_vllm",
	"lmstudio":      "lm_studio",
	"hf":            "huggingface",
	"venice":        "veniceai",
	"gradient":      "gradient_ai",
	"digitalocean":  "gradient_ai",
	"github_models": "github",
	"nanogpt":       "nano-gpt",
	"stima":         "apertis",
	"zhipuai":       "zai",
	"glm":           "zai",
	"comet":         "cometapi",
	"custom_openai": "openai_like",
	"jina":          "jina_ai",
	"voyageai":      "voyage",
}

func init() {
	for _, d := range defaults {
		api.Register(d.Name, openai.NewFactory(d))
	}
	for alias, canonical := range aliases {
		api.RegisterAlias(alias, canonical)
	}
}
