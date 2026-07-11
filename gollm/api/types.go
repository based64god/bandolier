// Package api defines gollm's unified request/response types and the provider
// SPI. The unified format is deliberately OpenAI-shaped: it is the de-facto
// lingua franca of LLM APIs, most non-OpenAI providers ship OpenAI-compatible
// endpoints, and every translation layer in this module converts to or from
// this one format — never provider-to-provider directly.
package api

import (
	"encoding/json"
	"net/http"
	"time"
)

// ChatRequest is a unified chat-completion request in OpenAI wire format.
// Fields that are pointers distinguish "unset" (omitted from the wire) from a
// zero value the caller actually chose. Provider adapters translate this into
// their native format; anything they don't support is dropped silently (as
// litellm does with drop_params) rather than erroring.
type ChatRequest struct {
	// Model in gollm form: "provider/model" (e.g. "anthropic/claude-sonnet-4-5",
	// "openrouter/meta-llama/llama-3.3-70b") or a bare model name, whose
	// provider is inferred (gpt-* → openai, claude-* → anthropic, ...).
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`

	Temperature         *float64           `json:"temperature,omitempty"`
	TopP                *float64           `json:"top_p,omitempty"`
	N                   *int               `json:"n,omitempty"`
	Stop                StringOrSlice      `json:"stop,omitempty"`
	MaxTokens           *int               `json:"max_tokens,omitempty"`
	MaxCompletionTokens *int               `json:"max_completion_tokens,omitempty"`
	PresencePenalty     *float64           `json:"presence_penalty,omitempty"`
	FrequencyPenalty    *float64           `json:"frequency_penalty,omitempty"`
	LogitBias           map[string]float64 `json:"logit_bias,omitempty"`
	User                string             `json:"user,omitempty"`
	Seed                *int               `json:"seed,omitempty"`
	Logprobs            *bool              `json:"logprobs,omitempty"`
	TopLogprobs         *int               `json:"top_logprobs,omitempty"`

	Tools             []Tool          `json:"tools,omitempty"`
	ToolChoice        *ToolChoice     `json:"tool_choice,omitempty"`
	ParallelToolCalls *bool           `json:"parallel_tool_calls,omitempty"`
	ResponseFormat    *ResponseFormat `json:"response_format,omitempty"`

	// ReasoningEffort is OpenAI's knob ("minimal"|"low"|"medium"|"high");
	// adapters for thinking-capable models map it to their native equivalent
	// (e.g. Anthropic thinking budgets).
	ReasoningEffort string `json:"reasoning_effort,omitempty"`

	Stream        bool           `json:"stream,omitempty"`
	StreamOptions *StreamOptions `json:"stream_options,omitempty"`

	// Extra carries provider-specific parameters that have no unified field
	// (litellm's kwargs passthrough). They are merged verbatim into the
	// provider wire request body, after the typed fields, so an Extra key can
	// also deliberately override a typed one.
	Extra map[string]any `json:"-"`

	// ── Routing/transport fields (never serialized to any provider wire) ──

	// APIKey overrides the provider's configured/env credential for this call.
	APIKey string `json:"-"`
	// BaseURL overrides the provider's endpoint for this call.
	BaseURL string `json:"-"`
	// Headers are added verbatim to the outbound provider HTTP request.
	Headers map[string]string `json:"-"`
	// Timeout bounds the provider HTTP call (0 = the provider's default).
	Timeout time.Duration `json:"-"`
}

// MarshalJSON merges Extra into the wire body. Typed fields marshal first;
// Extra keys overwrite on collision, which is the documented way to force a
// provider-specific value gollm doesn't model. The merge decodes the base
// into map[string]json.RawMessage (not map[string]any), so each typed field's
// value — critically, raw tool-schema bytes — is preserved verbatim rather
// than round-tripped through `any` (which would reorder object keys and retype
// numbers as float64). Only top-level key order is lost, which no API cares
// about.
func (r ChatRequest) MarshalJSON() ([]byte, error) {
	type plain ChatRequest // no methods: avoids recursing into this marshaller
	base, err := json.Marshal(plain(r))
	if err != nil {
		return nil, err
	}
	if len(r.Extra) == 0 {
		return base, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(base, &m); err != nil {
		return nil, err
	}
	for k, v := range r.Extra {
		raw, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		m[k] = raw
	}
	return json.Marshal(m)
}

// StreamOptions mirrors OpenAI's stream_options.
type StreamOptions struct {
	IncludeUsage bool `json:"include_usage,omitempty"`
}

// Message is one chat turn. Content is a string or a list of typed parts on
// the wire; assistant messages may carry ToolCalls instead of (or alongside)
// content, and tool-role messages answer a specific ToolCallID.
type Message struct {
	Role       string         `json:"role"`
	Content    MessageContent `json:"content"`
	Name       string         `json:"name,omitempty"`
	ToolCalls  []ToolCall     `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	// ReasoningContent carries a reasoning/thinking trace on assistant
	// messages, for backends that expose one (DeepSeek R1 wire name).
	ReasoningContent string `json:"reasoning_content,omitempty"`
	// ReasoningSignature carries the cryptographic signature Anthropic attaches
	// to a thinking block. It has no OpenAI wire representation (json:"-"); it
	// exists so a thinking block can round-trip through the unified format —
	// Anthropic backends reject multi-turn thinking history whose signatures
	// were stripped.
	ReasoningSignature string `json:"-"`
	// Refusal is OpenAI's structured-outputs refusal string (assistant
	// messages); content is null when it is set.
	Refusal string `json:"refusal,omitempty"`
}

// Tool declares a callable function in OpenAI format. Parameters is a raw
// JSON Schema — kept raw so translation layers never re-order or re-type a
// schema the model was prompted with.
type Tool struct {
	Type     string       `json:"type"` // always "function" today
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
	Strict      *bool           `json:"strict,omitempty"`
}

// ToolCall is a model-requested function invocation. Arguments is the raw
// (possibly partial, while streaming) JSON string exactly as the model
// produced it.
type ToolCall struct {
	// Index is only meaningful in stream deltas, where argument fragments are
	// correlated by index rather than id.
	Index    *int             `json:"index,omitempty"`
	ID       string           `json:"id,omitempty"`
	Type     string           `json:"type,omitempty"`
	Function ToolCallFunction `json:"function"`
}

type ToolCallFunction struct {
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments"`
}

// ResponseFormat mirrors OpenAI's response_format ("text", "json_object", or
// "json_schema" with an attached schema).
type ResponseFormat struct {
	Type       string          `json:"type"`
	JSONSchema *JSONSchemaSpec `json:"json_schema,omitempty"`
}

type JSONSchemaSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Schema      json.RawMessage `json:"schema,omitempty"`
	Strict      *bool           `json:"strict,omitempty"`
}

// ChatResponse is a unified non-streaming completion in OpenAI wire format.
type ChatResponse struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"` // "chat.completion"
	Created int64    `json:"created"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
	Usage   *Usage   `json:"usage,omitempty"`

	SystemFingerprint string `json:"system_fingerprint,omitempty"`

	// Provider is the gollm provider that served this response (not on the
	// OpenAI wire; useful for logging and cost attribution).
	Provider string `json:"-"`
}

type Choice struct {
	Index        int      `json:"index"`
	Message      Message  `json:"message"`
	FinishReason string   `json:"finish_reason"` // stop | length | tool_calls | content_filter
	Logprobs     Logprobs `json:"logprobs,omitempty"`
}

// Logprobs is kept raw: no gollm subsystem interprets it, so passing the
// provider's structure through unmodified is strictly more faithful.
type Logprobs = json.RawMessage

// Usage is OpenAI's token accounting, extended with the detail blocks newer
// APIs report (cached prompt tokens, reasoning tokens).
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`

	PromptTokensDetails     *PromptTokensDetails     `json:"prompt_tokens_details,omitempty"`
	CompletionTokensDetails *CompletionTokensDetails `json:"completion_tokens_details,omitempty"`
}

type PromptTokensDetails struct {
	CachedTokens int `json:"cached_tokens,omitempty"`
	AudioTokens  int `json:"audio_tokens,omitempty"`
	// CacheCreationTokens is Anthropic's cache-write count; carried here so
	// cost accounting can price cache writes (no OpenAI equivalent).
	CacheCreationTokens int `json:"cache_creation_tokens,omitempty"`
}

type CompletionTokensDetails struct {
	ReasoningTokens int `json:"reasoning_tokens,omitempty"`
	AudioTokens     int `json:"audio_tokens,omitempty"`
}

// ChatChunk is one streamed delta in OpenAI wire format
// ("chat.completion.chunk").
type ChatChunk struct {
	ID      string        `json:"id"`
	Object  string        `json:"object"`
	Created int64         `json:"created"`
	Model   string        `json:"model"`
	Choices []ChunkChoice `json:"choices"`
	// Usage arrives on a final chunk when stream_options.include_usage is set
	// (OpenAI) or unconditionally from providers that always report it.
	Usage             *Usage `json:"usage,omitempty"`
	SystemFingerprint string `json:"system_fingerprint,omitempty"`
}

type ChunkChoice struct {
	Index        int      `json:"index"`
	Delta        Delta    `json:"delta"`
	FinishReason string   `json:"finish_reason,omitempty"`
	Logprobs     Logprobs `json:"logprobs,omitempty"`
}

type Delta struct {
	Role             string     `json:"role,omitempty"`
	Content          string     `json:"content,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	// Refusal streams the structured-outputs refusal text.
	Refusal string `json:"refusal,omitempty"`
	// ReasoningSignature carries an Anthropic thinking-block signature fragment
	// (json:"-": no OpenAI wire slot; see Message.ReasoningSignature).
	ReasoningSignature string `json:"-"`
}

// ProviderConfig is everything a provider factory may need to construct an
// adapter. Zero values mean "use the provider's defaults" (env credential,
// public endpoint, http.DefaultClient).
type ProviderConfig struct {
	APIKey     string
	BaseURL    string
	APIVersion string
	HTTPClient *http.Client
	// Extra carries provider-specific settings that have no universal slot:
	// bedrock's region/credentials, vertex's project/location, azure's
	// deployment mapping, ...
	Extra map[string]string
}

// Client returns the configured HTTP client or http.DefaultClient.
func (c ProviderConfig) Client() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}
