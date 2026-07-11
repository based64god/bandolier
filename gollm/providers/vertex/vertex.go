// Package vertex implements the Google Vertex AI adapter. One provider serves
// two publisher families, dispatched by model id: Gemini models via the
// generateContent API (wire-identical to Google AI Studio) and Anthropic
// claude-* models via rawPredict (the Messages API with anthropic_version in
// the body instead of a model field — the model rides in the URL).
// Authentication is a service-account JWT bearer grant minted with the stdlib
// crypto stack; a pre-minted OAuth access token may be supplied as the API
// key to skip it.
package vertex

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/based64god/gollm/api"
)

const (
	providerName = "vertex"
	// anthropicVersion replaces the Messages API model field on Vertex.
	anthropicVersion = "vertex-2023-10-16"
	defaultLocation  = "us-central1"
)

// Provider is a Vertex AI adapter instance.
type Provider struct {
	cfg api.ProviderConfig

	// mu guards the lazily built token source (credentials are resolved on
	// first authenticated call, like the env-key lookup in other adapters).
	mu sync.Mutex
	ts *tokenSource
}

func init() {
	api.Register("vertex", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
	api.RegisterAlias("vertex_ai", "vertex")
	api.RegisterAlias("vertexai", "vertex")
}

func (p *Provider) Name() string { return providerName }

func (p *Provider) extra(key string) string {
	if p.cfg.Extra == nil {
		return ""
	}
	return p.cfg.Extra[key]
}

func (p *Provider) location() string {
	if v := p.extra("location"); v != "" {
		return v
	}
	if v := os.Getenv("VERTEXAI_LOCATION"); v != "" {
		return v
	}
	return defaultLocation
}

// project resolves the GCP project: explicit config, env, then the service
// account's own project_id.
func (p *Provider) project() (string, error) {
	if v := p.extra("project"); v != "" {
		return v, nil
	}
	for _, env := range []string{"VERTEXAI_PROJECT", "GOOGLE_CLOUD_PROJECT"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	if sa, _, err := p.credentials(); err == nil && sa.ProjectID != "" {
		return sa.ProjectID, nil
	}
	return "", authError(`no GCP project for vertex: set Extra["project"] or VERTEXAI_PROJECT / GOOGLE_CLOUD_PROJECT`)
}

// credentials loads the service-account key: inline JSON first, then the file
// named by GOOGLE_APPLICATION_CREDENTIALS. The token URL may be overridden
// via Extra["token_url"] (tests point it at a fake endpoint).
func (p *Provider) credentials() (*serviceAccount, string, error) {
	var data []byte
	if inline := p.extra("credentials_json"); inline != "" {
		data = []byte(inline)
	} else if path := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, "", authError(fmt.Sprintf("cannot read GOOGLE_APPLICATION_CREDENTIALS: %v", err))
		}
		data = b
	} else {
		return nil, "", authError(`no credentials for vertex: set Extra["credentials_json"], GOOGLE_APPLICATION_CREDENTIALS, or pass an OAuth access token as the API key`)
	}
	sa, err := parseServiceAccount(data)
	if err != nil {
		return nil, "", authError(err.Error())
	}
	tokenURL := p.extra("token_url")
	if tokenURL == "" {
		tokenURL = sa.TokenURI
	}
	if tokenURL == "" {
		tokenURL = defaultTokenURL
	}
	return sa, tokenURL, nil
}

// bearer resolves the OAuth token: a per-request or configured token is used
// verbatim; otherwise one is minted (and cached) from the service account.
func (p *Provider) bearer(ctx context.Context, override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	p.mu.Lock()
	if p.ts == nil {
		sa, tokenURL, err := p.credentials()
		if err != nil {
			p.mu.Unlock()
			return "", err
		}
		p.ts = &tokenSource{client: p.cfg.Client(), sa: sa, tokenURL: tokenURL}
	}
	ts := p.ts
	p.mu.Unlock()
	return ts.token(ctx)
}

// host is the API root: per-request override, then Extra["api_endpoint"]
// (verbatim), then cfg.BaseURL, then the regional Google endpoint.
func (p *Provider) host(override string) string {
	if override != "" {
		return strings.TrimRight(override, "/")
	}
	if v := p.extra("api_endpoint"); v != "" {
		return strings.TrimRight(v, "/")
	}
	if p.cfg.BaseURL != "" {
		return strings.TrimRight(p.cfg.BaseURL, "/")
	}
	if loc := p.location(); loc != "global" {
		return fmt.Sprintf("https://%s-aiplatform.googleapis.com", loc)
	}
	return "https://aiplatform.googleapis.com"
}

// modelURL builds the publisher-model endpoint for one verb (generateContent,
// streamGenerateContent, rawPredict, streamRawPredict, predict).
func (p *Provider) modelURL(baseOverride, publisher, model, verb string) (string, error) {
	project, err := p.project()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s/v1/projects/%s/locations/%s/publishers/%s/models/%s:%s",
		p.host(baseOverride), project, p.location(), publisher, model, verb), nil
}

// isClaude selects the anthropic publisher by model id prefix; everything
// else is served as a Gemini model.
func isClaude(model string) bool {
	return strings.HasPrefix(strings.ToLower(model), "claude")
}

// do POSTs a JSON payload with bearer auth; non-2xx becomes a classified
// *api.Error (Google's {"error":{"message"}} envelope is understood by
// ErrorFromHTTP).
func (p *Provider) do(ctx context.Context, url, model, keyOverride string, headers map[string]string, payload []byte) (*http.Response, error) {
	tok, err := p.bearer(ctx, keyOverride)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport(providerName, model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+tok)
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport(providerName, model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP(providerName, model, resp.StatusCode, raw, retryAfter(resp))
	}
	return resp, nil
}

// retryAfter parses the Retry-After header (seconds form only).
func retryAfter(resp *http.Response) time.Duration {
	if v := resp.Header.Get("Retry-After"); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return 0
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	// Per-request timeout bounds non-streaming calls only; on streams it
	// would sever long generations mid-flight.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	if isClaude(req.Model) {
		return p.claudeComplete(ctx, req)
	}
	return p.geminiComplete(ctx, req)
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	if isClaude(req.Model) {
		return p.claudeStream(ctx, req)
	}
	return p.geminiStream(ctx, req)
}

func badRequest(model string, err error) *api.Error {
	return &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: providerName, Model: model, Message: err.Error()}
}

func malformed(model string, err error) *api.Error {
	return &api.Error{
		Type: api.ErrInternalServer, StatusCode: 502, Provider: providerName,
		Model: model, Message: fmt.Sprintf("malformed response: %v", err),
	}
}
