# gollm

A Go rebuild of [litellm](https://github.com/BerriAI/litellm): one client for
100+ LLM deployments behind two standard wire formats, plus a production-lean
proxy with routing, fallbacks, virtual keys, and spend tracking.

**The headline feature: point Claude Code at any model provider.** gollm's
proxy speaks the Anthropic Messages API — streaming, tool use, images,
thinking blocks, `count_tokens` — and translates it to OpenAI, Google Gemini,
Groq, DeepSeek, xAI, Mistral, Bedrock, Vertex, Azure, Ollama, and any
OpenAI-compatible endpoint.

## Run Claude Code on a different backend

1. Write a config mapping the model names Claude Code asks for to real
   deployments (see [config.example.yaml](config.example.yaml)):

```yaml
model_list:
  - model_name: claude-sonnet-4-5          # what Claude Code requests
    params:
      model: openai/gpt-5.2                # what actually serves it
      api_key: os.environ/OPENAI_API_KEY
  - model_name: claude-3-5-haiku-20241022  # background tasks → something cheap
    params:
      model: groq/llama-3.3-70b-versatile
      api_key: os.environ/GROQ_API_KEY
  - model_name: "claude-*"                 # everything else → local Ollama
    params:
      model: ollama/qwen3-coder:30b

general_settings:
  master_key: os.environ/GOLLM_MASTER_KEY
```

2. Start the proxy:

```console
$ go run ./cmd/gollm proxy --config config.yaml --port 4000
```

3. Point Claude Code at it:

```console
$ export ANTHROPIC_BASE_URL=http://localhost:4000
$ export ANTHROPIC_AUTH_TOKEN=$GOLLM_MASTER_KEY
$ claude
```

That's it. Claude Code's `/v1/messages` traffic — including streaming SSE,
parallel tool calls, images, and interleaved thinking — is translated to each
alias's backend and back. Aliases that map to a *real* Anthropic deployment
are forwarded **verbatim** (passthrough), so prompt-cache breakpoints and
thinking signatures keep working; you can mix, e.g., Opus on Anthropic with
Haiku on Groq.

Useful companions:

- `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` — make Claude Code request
  whatever alias names you prefer.
- `POST /key/generate` (master key required) — mint virtual keys with budgets
  and model allowlists for teammates:
  `curl -H "Authorization: Bearer $GOLLM_MASTER_KEY" -d '{"key_alias":"emmett","max_budget":25}' localhost:4000/key/generate`
- `GET /spend/logs` — recent requests with token counts and USD cost.

## The SDK

```go
import (
    "github.com/based64god/gollm"
    "github.com/based64god/gollm/api"
)

resp, err := gollm.Completion(ctx, &api.ChatRequest{
    Model: "anthropic/claude-sonnet-4-5",   // or "gemini/gemini-2.5-pro", "groq/...", bare "gpt-4o", ...
    Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
})
```

The unified format is OpenAI-shaped (`api.ChatRequest`/`api.ChatResponse`);
model strings are `provider/model` with litellm's prefix conventions, and
bare names infer their provider (`gpt-*` → openai, `claude-*` → anthropic,
…). Streaming:

```go
stream, _ := gollm.Stream(ctx, req)
defer stream.Close()
for {
    chunk, err := stream.Recv()
    if err == io.EOF { break }
    fmt.Print(chunk.Choices[0].Delta.Content)
}
```

### Providers

| Provider | Prefix | Chat | Streaming | Tools | Embeddings |
|---|---|---|---|---|---|
| OpenAI | `openai/` (default) | ✓ | ✓ | ✓ | ✓ |
| ChatGPT subscription (Codex backend, OAuth from `codex login`) | `chatgpt/` | ✓ | ✓ | ✓ | — |
| Anthropic | `anthropic/` | ✓ | ✓ | ✓ | — |
| Google AI Studio | `gemini/` | ✓ | ✓ | ✓ | ✓ |
| Vertex AI (Gemini + Claude) | `vertex/` | ✓ | ✓ | ✓ | ✓ |
| Azure OpenAI | `azure/<deployment>` | ✓ | ✓ | ✓ | ✓ |
| AWS Bedrock (Converse) | `bedrock/` | ✓ | ✓ | ✓ | — |
| Cohere | `cohere/` | ✓ | ✓ | ✓ | ✓ |
| Ollama | `ollama/` | ✓ | ✓ | ✓ | ✓ |
| GitHub Copilot (subscription, OAuth token exchange) | `github_copilot/` | ✓ | ✓ | ✓ | — |
| Amazon SageMaker (Messages API endpoints, SigV4) | `sagemaker/` | ✓ | ✓ | ✓ | — |
| IBM watsonx.ai (IAM auth, projects + deployments) | `watsonx/` | ✓ | ✓ | ✓ | — |
| Snowflake Cortex (key-pair JWT / PAT) | `snowflake/` | ✓ | ✓ | ✓ | — |
| Replicate (predictions API, poll + SSE) | `replicate/` | ✓ | ✓ | — | — |
| Sber GigaChat (NGW OAuth) | `gigachat/` | ✓ | ✓ | ✓ | — |
| OCI Generative AI (HTTP-Signature auth; GENERIC + Cohere formats) | `oci/` | ✓ | ✓ | GENERIC only | — |
| NVIDIA Triton (/generate extension) | `triton/` | ✓ | ✓ | — | — |
| Predibase (TGI generate) | `predibase/` | ✓ | ✓ | — | — |
| NLP Cloud | `nlp_cloud/` | ✓ | replayed | — | — |
| Petals swarm (chat.petals.dev HTTP API) | `petals/` | ✓ | replayed | — | — |
| Bytez | `bytez/` | ✓ | ✓ | — | — |
| ~80 OpenAI-compatible providers (litellm's roster) | their litellm name | ✓ | ✓ | ✓ | varies |

The last row is the compat registry (`providers/compat`): every OpenAI-compatible
provider litellm supports, with litellm's base URLs and env var names so litellm
configs and environments drop in. Hosted clouds and gateways (Groq, DeepSeek,
xAI, Mistral, Codestral, Together, Fireworks, OpenRouter, Perplexity, Cerebras,
Moonshot/Kimi, NVIDIA NIM, Anyscale, DeepInfra, AI21, Baseten, SambaNova,
Volcengine, Tencent, Empower, FriendliAI, Galadriel, GitHub Models, Meta Llama
API, Nebius, Novita, Featherless, Nscale, DashScope/Qwen, ModelScope, v0, Morph,
Lambda, Inception, Hyperbolic, AI/ML API, W&B Inference, CometAPI, Clarifai,
Z.AI/GLM, MiniMax, DigitalOcean Gradient, Hugging Face router, DataRobot, Vercel
AI Gateway, Helicone, Venice, Scaleway, PublicAI, Poe, Chutes, and more) have
public default endpoints; self-hosted backends (vLLM, llamafile, LM Studio,
Docker Model Runner, Lemonade, Xinference, RAGFlow, a litellm proxy, Databricks,
Azure AI Foundry, Cloudflare Workers AI, Heroku) are pointed at a deployment via
their `*_API_BASE` env var (local ones default to their conventional localhost
port and need no key).

Credential notes for the bespoke-auth adapters: `github_copilot` needs a
GitHub OAuth token with Copilot access (`GITHUB_COPILOT_ACCESS_TOKEN`; the
short-lived Copilot session token is minted and refreshed automatically);
`sagemaker` uses the AWS credentials/region convention (the model is the
inference endpoint name, Messages-API containers only); `watsonx` takes
`WATSONX_URL` + `WATSONX_APIKEY` + `WATSONX_PROJECT_ID` (deployment models via
`deployment/<id>`); `snowflake` takes `SNOWFLAKE_ACCOUNT_ID` plus a key-pair
JWT or `pat/<token>`; `gigachat` exchanges `GIGACHAT_CREDENTIALS` at Sber's
NGW (their Russian-CA TLS chain must be trusted by your client).

`oci` signs requests with OCI's draft-cavage HTTP-Signature scheme
(`OCI_USER`, `OCI_FINGERPRINT`, `OCI_TENANCY`, `OCI_COMPARTMENT_ID`,
`OCI_REGION`, and `OCI_KEY`/`OCI_KEY_FILE`); cohere.* models use OCI's COHERE
format (text chat only), everything else the GENERIC format with tools.
"Replayed" streaming means the backend has no native stream, so Stream
returns the completed answer as one chunk. litellm's in-process modes (the
bare `vllm/` and `petals/` Python-library backends) have no wire protocol and
therefore no gollm equivalent — their HTTP twins (`hosted_vllm/`, the Petals
swarm API) are what gollm serves. That closes out litellm's chat-provider
roster.

Credentials come from each provider's conventional env var
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …) or explicit
configuration (`Client.Configure`, or per-request `req.APIKey`/`req.BaseURL`).

### Router

`router.Router` load-balances named deployments with litellm's semantics:
weighted shuffle / round-robin / least-busy / latency-based strategies,
per-deployment RPM/TPM limits, retries with exponential backoff (honoring
`Retry-After`), cooldowns after repeated failures, fallback chains, and
dedicated context-window-exceeded fallbacks.

### Costs and tokens

`costs.Cost(model, usage)` prices usage (including cache reads/writes)
against a pricing table generated from litellm's; `costs.Register` adds
custom models. `tokens.Estimate*` provide fast heuristic token counts
(~4 chars/token) used for `count_tokens` and pre-flight checks — approximate
by design.

## Proxy API surface

| Endpoint | Format |
|---|---|
| `POST /v1/messages` | Anthropic Messages API (streaming + non-streaming) |
| `POST /v1/messages/count_tokens` | Anthropic (forwarded when the backend is Anthropic; estimated otherwise) |
| `POST /v1/chat/completions` | OpenAI |
| `POST /v1/embeddings` | OpenAI |
| `GET /v1/models` | OpenAI |
| `POST /key/generate`, `GET /key/info` | admin (master key) |
| `GET /spend/logs` | admin (master key) |
| `GET /health` | unauthenticated |

Auth accepts `Authorization: Bearer <key>` or `x-api-key: <key>` — both of
Claude Code's conventions.

## What's deliberately smaller than litellm

Single binary, in-memory state (virtual keys optionally persist to a JSON
file), no database, no admin UI, no callbacks marketplace. Token counts for
non-Anthropic backends are heuristic, not tokenizer-exact. Server-side tools
(web search, computer use) only pass through to Anthropic backends.
