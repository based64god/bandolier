// Package azure implements the Azure OpenAI adapter. The wire format is
// OpenAI's, so request/response translation is a passthrough; only the
// transport differs: per-deployment URLs
// ({base}/openai/deployments/{deployment}/...?api-version=...) and an
// "api-key" header instead of Authorization Bearer. The gollm model id is the
// Azure DEPLOYMENT name ("azure/my-gpt4o-deployment"); the body still carries
// it as "model" (Azure ignores the field).
package azure

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

const providerName = "azure"

// defaultAPIVersion is used when neither ProviderConfig.APIVersion nor
// AZURE_API_VERSION is set.
const defaultAPIVersion = "2025-04-01-preview"

// Provider is the Azure OpenAI adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func init() {
	api.Register(providerName, New)
	api.RegisterAlias("azure_openai", providerName)
}

// New constructs the adapter; a zero config resolves everything from the
// AZURE_* environment variables.
func New(cfg api.ProviderConfig) (api.Provider, error) {
	return &Provider{cfg: cfg}, nil
}

func (p *Provider) Name() string { return providerName }

// key resolves the credential: per-request override, configured key, then
// AZURE_API_KEY with AZURE_OPENAI_API_KEY as the legacy fallback.
func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range []string{"AZURE_API_KEY", "AZURE_OPENAI_API_KEY"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	return "", &api.Error{
		Type:       api.ErrAuthentication,
		StatusCode: 401,
		Provider:   providerName,
		Message:    "no API key for azure: pass one or set AZURE_API_KEY (or AZURE_OPENAI_API_KEY)",
	}
}

// base resolves the resource endpoint; Azure has no public default, so a
// missing base is a configuration error.
func (p *Provider) base(override string) (string, error) {
	base := p.cfg.BaseURL
	if v := os.Getenv("AZURE_API_BASE"); base == "" && v != "" {
		base = v
	}
	if override != "" {
		base = override
	}
	if base == "" {
		return "", &api.Error{
			Type:       api.ErrAuthentication,
			StatusCode: 401,
			Provider:   providerName,
			Message:    "no Azure endpoint: set AZURE_API_BASE (e.g. https://myresource.openai.azure.com) or configure BaseURL",
		}
	}
	return strings.TrimRight(base, "/"), nil
}

func (p *Provider) apiVersion() string {
	if p.cfg.APIVersion != "" {
		return p.cfg.APIVersion
	}
	if v := os.Getenv("AZURE_API_VERSION"); v != "" {
		return v
	}
	return defaultAPIVersion
}

// requestURL builds the per-deployment endpoint. A base that already contains
// "/openai/deployments" is treated as a full deployment URL (the
// openai-python Azure client's convention, mirrored by litellm) and only the
// operation is appended.
func requestURL(base, deployment, op, version string) string {
	var u string
	if strings.Contains(base, "/openai/deployments") {
		u = base + "/" + op
	} else {
		u = base + "/openai/deployments/" + url.PathEscape(deployment) + "/" + op
	}
	return u + "?api-version=" + url.QueryEscape(version)
}

func (p *Provider) do(ctx context.Context, op string, req *api.ChatRequest, body any) (*http.Response, error) {
	apiKey, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	base, err := p.base(req.BaseURL)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: providerName, Message: err.Error()}
	}

	endpoint := requestURL(base, req.Model, op, p.apiVersion())
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport(providerName, req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// Azure authenticates with "api-key", not Authorization Bearer.
	httpReq.Header.Set("api-key", apiKey)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport(providerName, req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP(providerName, req.Model, resp.StatusCode, raw, retryAfter(resp))
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
	wire := *req
	wire.Stream = false
	wire.StreamOptions = nil

	// Per-request timeout applies to the non-streaming call as a whole; for
	// streams it would sever long generations mid-flight, so Stream skips it.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	resp, err := p.do(ctx, "chat/completions", req, &wire)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out api.ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: providerName,
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	out.Provider = providerName
	return &out, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	wire := *req
	wire.Stream = true
	if wire.StreamOptions == nil {
		wire.StreamOptions = &api.StreamOptions{IncludeUsage: true}
	}

	resp, err := p.do(ctx, "chat/completions", req, &wire)
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
				return nil, api.WrapTransport(providerName, req.Model, err)
			}
			if ev.IsDone() {
				return nil, io.EOF
			}
			if len(ev.Data) == 0 {
				continue
			}
			// Azure interleaves error objects mid-stream (content-filter
			// aborts, overload); they decode as an empty ChatChunk, so probe
			// for them before unmarshalling.
			if apiErr := sniffStreamError(req.Model, ev.Data); apiErr != nil {
				return nil, apiErr
			}
			var chunk api.ChatChunk
			if err := json.Unmarshal(ev.Data, &chunk); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: providerName,
					Model: req.Model, Message: fmt.Sprintf("malformed stream chunk: %v", err),
				}
			}
			return &chunk, nil
		}
	}, resp.Body.Close), nil
}

// sniffStreamError detects an {"error": ...} payload in a stream.
func sniffStreamError(model string, data []byte) *api.Error {
	var probe struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &probe); err != nil || probe.Error == nil {
		return nil
	}
	return api.ErrorFromHTTP(providerName, model, 500, data, 0)
}

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	// do() reads routing fields off a ChatRequest shim; Model doubles as the
	// deployment segment of the URL.
	chatReq := &api.ChatRequest{Model: req.Model, APIKey: req.APIKey, BaseURL: req.BaseURL, Headers: req.Headers}
	resp, err := p.do(ctx, "embeddings", chatReq, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out api.EmbeddingResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: providerName,
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	return &out, nil
}
