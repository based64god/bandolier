// Package openai implements the OpenAI chat/embeddings adapter. Because the
// unified format is OpenAI-shaped, this adapter is nearly a passthrough — and
// it doubles as the engine behind every OpenAI-compatible provider (groq,
// deepseek, xai, together, ...), which differ only in endpoint, credential
// env var, and a few capability quirks (see Defaults).
package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

// Defaults parameterize an OpenAI-compatible provider.
type Defaults struct {
	// Name is the canonical provider name ("openai", "groq", ...).
	Name string
	// BaseURL is the API root including any version segment
	// (e.g. "https://api.groq.com/openai/v1"). May be empty for self-hosted
	// providers that must be pointed at a deployment via BaseURLEnvs.
	BaseURL string
	// BaseURLEnvs are checked in order (before falling back to BaseURL) when
	// no endpoint is configured — how self-hosted providers (vLLM, llamafile,
	// LM Studio, a litellm proxy, ...) name their deployment.
	BaseURLEnvs []string
	// APIKeyEnvs are checked in order when no key is configured.
	APIKeyEnvs []string
	// DefaultAPIKey is sent when no credential is configured or found in the
	// environment — local backends accept any bearer (litellm sends a
	// placeholder the same way). Empty means a missing key is an error.
	DefaultAPIKey string
	// StreamOptionsSupported gates sending stream_options.include_usage —
	// some compat backends reject unknown fields.
	StreamOptionsSupported bool
	// EmbeddingsSupported gates the embeddings endpoint.
	EmbeddingsSupported bool
}

// Provider is an OpenAI(-compatible) adapter instance.
type Provider struct {
	defaults Defaults
	cfg      api.ProviderConfig
}

func init() {
	api.Register("openai", NewFactory(Defaults{
		Name:                   "openai",
		BaseURL:                "https://api.openai.com/v1",
		APIKeyEnvs:             []string{"OPENAI_API_KEY"},
		StreamOptionsSupported: true,
		EmbeddingsSupported:    true,
	}))
}

// NewFactory builds an api.Factory for an OpenAI-compatible provider with the
// given defaults; compat wrappers (groq, deepseek, ...) register themselves
// through this.
func NewFactory(defaults Defaults) api.Factory {
	return func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{defaults: defaults, cfg: cfg}, nil
	}
}

func (p *Provider) Name() string { return p.defaults.Name }

// key resolves the credential: per-request override, configured key, then
// the provider's env vars.
func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range p.defaults.APIKeyEnvs {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	if p.defaults.DefaultAPIKey != "" {
		return p.defaults.DefaultAPIKey, nil
	}
	return "", &api.Error{
		Type:       api.ErrAuthentication,
		StatusCode: 401,
		Provider:   p.defaults.Name,
		Message: fmt.Sprintf("no API key for %s: pass one or set %s",
			p.defaults.Name, strings.Join(p.defaults.APIKeyEnvs, " or ")),
	}
}

func (p *Provider) baseURL(override string) string {
	base := p.defaults.BaseURL
	for _, env := range p.defaults.BaseURLEnvs {
		if v := os.Getenv(env); v != "" {
			base = v
			break
		}
	}
	if p.cfg.BaseURL != "" {
		base = p.cfg.BaseURL
	}
	if override != "" {
		base = override
	}
	return strings.TrimRight(base, "/")
}

// prepare shallow-copies the request with provider quirks applied.
func (p *Provider) prepare(req *api.ChatRequest) *api.ChatRequest {
	out := *req

	// Reasoning-family OpenAI models reject max_tokens in favor of
	// max_completion_tokens; move it rather than failing the call.
	if p.defaults.Name == "openai" && out.MaxTokens != nil && out.MaxCompletionTokens == nil &&
		needsMaxCompletionTokens(out.Model) {
		out.MaxCompletionTokens = out.MaxTokens
		out.MaxTokens = nil
	}
	return &out
}

// needsMaxCompletionTokens reports OpenAI models that reject the legacy
// max_tokens parameter.
func needsMaxCompletionTokens(model string) bool {
	m := strings.ToLower(model)
	for _, prefix := range []string{"o1", "o3", "o4", "gpt-5"} {
		if strings.HasPrefix(m, prefix) {
			return true
		}
	}
	return false
}

func (p *Provider) do(ctx context.Context, path string, req *api.ChatRequest, body any) (*http.Response, error) {
	apiKey, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	if p.baseURL(req.BaseURL) == "" {
		// Self-hosted providers have no public endpoint to default to.
		return nil, &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: p.defaults.Name,
			Message: fmt.Sprintf("no endpoint for %s: set %s or configure api_base",
				p.defaults.Name, strings.Join(p.defaults.BaseURLEnvs, " or ")),
		}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: p.defaults.Name, Message: err.Error()}
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL(req.BaseURL)+path, bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport(p.defaults.Name, req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport(p.defaults.Name, req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP(p.defaults.Name, req.Model, resp.StatusCode, raw, retryAfter(resp))
	}
	return resp, nil
}

// retryAfter parses the Retry-After header (seconds form; the HTTP-date form
// is rare on LLM APIs and ignored).
func retryAfter(resp *http.Response) time.Duration {
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	return 0
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	wire := p.prepare(req)
	wire.Stream = false
	wire.StreamOptions = nil

	// Per-request timeout applies to the non-streaming call as a whole; for
	// streams it would sever long generations mid-flight, so Stream skips it.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	resp, err := p.do(ctx, "/chat/completions", req, wire)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out api.ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: p.defaults.Name,
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	out.Provider = p.defaults.Name
	return &out, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	wire := p.prepare(req)
	wire.Stream = true
	if p.defaults.StreamOptionsSupported && wire.StreamOptions == nil {
		wire.StreamOptions = &api.StreamOptions{IncludeUsage: true}
	} else if !p.defaults.StreamOptionsSupported {
		wire.StreamOptions = nil
	}

	resp, err := p.do(ctx, "/chat/completions", req, wire)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport(p.defaults.Name, req.Model, err)
			}
			if ev.IsDone() {
				return nil, io.EOF
			}
			if len(ev.Data) == 0 {
				continue
			}
			// Some compat backends interleave {"error": ...} objects
			// mid-stream. Such a payload unmarshals cleanly into an empty
			// ChatChunk (unknown fields are ignored), so it must be sniffed
			// before chunk decoding, not only on decode failure.
			if apiErr := sniffStreamError(p.defaults.Name, req.Model, ev.Data); apiErr != nil {
				return nil, apiErr
			}
			var chunk api.ChatChunk
			if err := json.Unmarshal(ev.Data, &chunk); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: p.defaults.Name,
					Model: req.Model, Message: fmt.Sprintf("malformed stream chunk: %v", err),
				}
			}
			return &chunk, nil
		}
	}, resp.Body.Close), nil
}

// sniffStreamError detects an {"error": ...} payload in a stream. RawMessage
// keeps the probe shape-agnostic (object or bare string error values); a JSON
// null does not count as an error.
func sniffStreamError(provider, model string, data []byte) *api.Error {
	var probe struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(data, &probe); err != nil ||
		len(probe.Error) == 0 || string(probe.Error) == "null" {
		return nil
	}
	return api.ErrorFromHTTP(provider, model, 500, data, 0)
}

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	if !p.defaults.EmbeddingsSupported {
		return nil, api.NotSupported(p.defaults.Name, "embeddings")
	}
	chatReq := &api.ChatRequest{Model: req.Model, APIKey: req.APIKey, BaseURL: req.BaseURL, Headers: req.Headers}
	resp, err := p.do(ctx, "/embeddings", chatReq, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out api.EmbeddingResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: p.defaults.Name,
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	return &out, nil
}
