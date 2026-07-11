// Package anthropicp is the Anthropic Messages API provider adapter (the
// outbound direction of the anthropic wire package; the "p" suffix avoids
// colliding with that package's import path). It also exposes RawMessages,
// the passthrough the proxy uses when an Anthropic-format client talks to an
// Anthropic backend — forwarding the original body preserves cache_control
// markers and thinking signatures that a double translation would destroy.
package anthropicp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/based64god/gollm/anthropic"
	"github.com/based64god/gollm/api"
)

const defaultBaseURL = "https://api.anthropic.com"

// Provider is an Anthropic Messages API adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func init() {
	api.Register("anthropic", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
	api.RegisterAlias("claude", "anthropic")
}

func (p *Provider) Name() string { return "anthropic" }

func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	return "", &api.Error{
		Type:       api.ErrAuthentication,
		StatusCode: 401,
		Provider:   "anthropic",
		Message:    "no API key for anthropic: pass one or set ANTHROPIC_API_KEY",
	}
}

func (p *Provider) baseURL(override string) string {
	base := defaultBaseURL
	if p.cfg.BaseURL != "" {
		base = p.cfg.BaseURL
	}
	if override != "" {
		base = override
	}
	return base
}

func (p *Provider) version() string {
	if p.cfg.APIVersion != "" {
		return p.cfg.APIVersion
	}
	return anthropic.Version
}

// do posts a Messages API body and returns the raw response, translating
// non-2xx into classified errors.
func (p *Provider) do(ctx context.Context, body []byte, model, keyOverride, baseOverride string, headers map[string]string) (*http.Response, error) {
	apiKey, err := p.key(keyOverride)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL(baseOverride)+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return nil, api.WrapTransport("anthropic", model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", p.version())
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("anthropic", model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("anthropic", model, resp.StatusCode, raw, retryAfter(resp))
	}
	return resp, nil
}

func retryAfter(resp *http.Response) time.Duration {
	if v := resp.Header.Get("retry-after"); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return 0
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	mreq, err := anthropic.RequestFromUnified(req)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "anthropic", Model: req.Model, Message: err.Error()}
	}
	mreq.Stream = false
	body, err := json.Marshal(mreq)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "anthropic", Model: req.Model, Message: err.Error()}
	}

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	resp, err := p.do(ctx, body, req.Model, req.APIKey, req.BaseURL, req.Headers)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var mresp anthropic.MessagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&mresp); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "anthropic",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	out := anthropic.ResponseToUnified(&mresp)
	out.Provider = "anthropic"
	return out, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	mreq, err := anthropic.RequestFromUnified(req)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "anthropic", Model: req.Model, Message: err.Error()}
	}
	mreq.Stream = true
	body, err := json.Marshal(mreq)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "anthropic", Model: req.Model, Message: err.Error()}
	}

	resp, err := p.do(ctx, body, req.Model, req.APIKey, req.BaseURL, req.Headers)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	dec := anthropic.NewDecodeState()
	done := false
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			if done {
				return nil, io.EOF
			}
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport("anthropic", req.Model, err)
			}
			var sev anthropic.StreamEvent
			if err := json.Unmarshal(ev.Data, &sev); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: "anthropic",
					Model: req.Model, Message: fmt.Sprintf("malformed stream event: %v", err),
				}
			}
			if sev.Type == "message_stop" {
				done = true
				return nil, io.EOF
			}
			chunk, err := dec.Event(&sev)
			if err != nil {
				return nil, err
			}
			if chunk != nil {
				return chunk, nil
			}
		}
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("anthropic", "embeddings")
}

// RawMessages forwards an already-encoded Messages API body verbatim and
// returns the raw HTTP response, streaming or not. The proxy uses this when
// both the client and the backend speak the Anthropic wire format, so nothing
// is lost in translation; key/base override the provider defaults with the
// serving deployment's credentials. The caller owns the response body.
func (p *Provider) RawMessages(ctx context.Context, body []byte, model, key, base string, headers map[string]string) (*http.Response, error) {
	return p.do(ctx, body, model, key, base, headers)
}

// CountTokens proxies POST /v1/messages/count_tokens for Anthropic backends;
// key/base override the provider defaults as in RawMessages.
func (p *Provider) CountTokens(ctx context.Context, body []byte, model, key, base string) (*anthropic.CountTokensResponse, error) {
	apiKey, err := p.key(key)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL(base)+"/v1/messages/count_tokens", bytes.NewReader(body))
	if err != nil {
		return nil, api.WrapTransport("anthropic", model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", p.version())

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("anthropic", model, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("anthropic", model, resp.StatusCode, raw, retryAfter(resp))
	}
	var out anthropic.CountTokensResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "anthropic",
			Model: model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	return &out, nil
}
