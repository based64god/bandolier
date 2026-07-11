// Package snowflake implements the Snowflake Cortex adapter: the
// OpenAI-format /api/v2/cortex/v1/chat/completions surface, authenticated
// with a key-pair JWT or a programmatic access token (PAT, passed with a
// "pat/" prefix, litellm's convention). The openai adapter does the wire
// work; this package owns the account URL and the Snowflake auth headers.
//
// Anthropic models on Cortex also have a native /messages endpoint; gollm
// routes everything through chat/completions, which Cortex serves for all
// models.
package snowflake

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/providers/openai"
)

func init() {
	api.Register("snowflake", func(cfg api.ProviderConfig) (api.Provider, error) {
		inner, err := openai.NewFactory(openai.Defaults{Name: "snowflake"})(cfg)
		if err != nil {
			return nil, err
		}
		return &Provider{cfg: cfg, inner: inner}, nil
	})
}

// Provider adapts Snowflake Cortex.
type Provider struct {
	cfg   api.ProviderConfig
	inner api.Provider
}

func (p *Provider) Name() string { return "snowflake" }

// base resolves the Cortex chat root: {account base}/cortex/v1, where the
// account base is SNOWFLAKE_API_BASE (…/api/v2) or built from
// SNOWFLAKE_ACCOUNT_ID.
func (p *Provider) base(override string) (string, error) {
	base := p.cfg.BaseURL
	if override != "" {
		base = override
	}
	if base == "" {
		base = os.Getenv("SNOWFLAKE_API_BASE")
	}
	if base == "" {
		if account := os.Getenv("SNOWFLAKE_ACCOUNT_ID"); account != "" {
			base = fmt.Sprintf("https://%s.snowflakecomputing.com/api/v2", account)
		}
	}
	if base == "" {
		return "", &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: "snowflake",
			Message: "no Snowflake endpoint: set SNOWFLAKE_ACCOUNT_ID or SNOWFLAKE_API_BASE (https://<account>.snowflakecomputing.com/api/v2)",
		}
	}
	return strings.TrimRight(base, "/") + "/cortex/v1", nil
}

// key resolves the credential: a key-pair JWT, or a PAT carried with a
// "pat/" prefix.
func (p *Provider) key(override string) (string, error) {
	key := override
	if key == "" {
		key = p.cfg.APIKey
	}
	if key == "" {
		for _, env := range []string{"SNOWFLAKE_JWT", "SNOWFLAKE_API_KEY", "SNOWFLAKE_TOKEN"} {
			if v := os.Getenv(env); v != "" {
				key = v
				break
			}
		}
	}
	if key == "" {
		return "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "snowflake",
			Message: "no Snowflake credentials: set SNOWFLAKE_JWT (key-pair JWT) or SNOWFLAKE_API_KEY (\"pat/<token>\" for a programmatic access token)",
		}
	}
	return key, nil
}

func (p *Provider) prepare(req *api.ChatRequest) (*api.ChatRequest, error) {
	out := *req

	base, err := p.base(req.BaseURL)
	if err != nil {
		return nil, err
	}
	out.BaseURL = base

	key, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	tokenType := "KEYPAIR_JWT"
	if pat, ok := strings.CutPrefix(key, "pat/"); ok {
		tokenType = "PROGRAMMATIC_ACCESS_TOKEN"
		key = pat
	}
	out.APIKey = key

	headers := make(map[string]string, len(req.Headers)+2)
	headers["X-Snowflake-Authorization-Token-Type"] = tokenType
	headers["Accept"] = "application/json"
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	for k, v := range req.Headers {
		headers[k] = v
	}
	out.Headers = headers
	return &out, nil
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	wire, err := p.prepare(req)
	if err != nil {
		return nil, err
	}
	return p.inner.Complete(ctx, wire)
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	wire, err := p.prepare(req)
	if err != nil {
		return nil, err
	}
	return p.inner.Stream(ctx, wire)
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("snowflake", "embeddings")
}
