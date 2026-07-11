// Package gollm is a Go rebuild of litellm: one client for many LLM
// providers, speaking a unified OpenAI-shaped format, with an
// Anthropic-compatible proxy (see the proxy package) that lets tools like
// Claude Code run against any configured backend.
//
//	resp, err := gollm.Completion(ctx, &api.ChatRequest{
//	    Model:    "anthropic/claude-sonnet-4-5",
//	    Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
//	})
package gollm

import (
	"context"
	"sync"

	"github.com/based64god/gollm/api"
	_ "github.com/based64god/gollm/providers/all" // register built-in providers
)

// Client routes unified requests to provider adapters, constructing and
// caching one adapter per provider name. The zero value is not usable; call
// New.
type Client struct {
	mu        sync.Mutex
	providers map[string]api.Provider
	configs   map[string]api.ProviderConfig
}

// New builds a client with default provider configurations (credentials from
// conventional env vars).
func New() *Client {
	return &Client{
		providers: map[string]api.Provider{},
		configs:   map[string]api.ProviderConfig{},
	}
}

// Configure sets (or replaces) a provider's configuration; the adapter is
// rebuilt on next use. Call before issuing requests for that provider.
func (c *Client) Configure(provider string, cfg api.ProviderConfig) {
	canonical, _ := api.Resolve(provider)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.configs[canonical] = cfg
	delete(c.providers, canonical)
}

// Provider returns the (cached) adapter for a provider name.
func (c *Client) Provider(name string) (api.Provider, error) {
	canonical, ok := api.Resolve(name)
	if !ok {
		canonical = name // let NewProvider produce the helpful error
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if p, ok := c.providers[canonical]; ok {
		return p, nil
	}
	p, err := api.NewProvider(canonical, c.configs[canonical])
	if err != nil {
		return nil, err
	}
	c.providers[canonical] = p
	return p, nil
}

// route resolves the request's model into (provider adapter, provider-local
// model id).
func (c *Client) route(model string) (api.Provider, string, error) {
	providerName, rest := api.SplitModel(model)
	p, err := c.Provider(providerName)
	if err != nil {
		return nil, "", err
	}
	return p, rest, nil
}

// Completion executes a non-streaming chat completion.
func (c *Client) Completion(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	p, model, err := c.route(req.Model)
	if err != nil {
		return nil, err
	}
	local := *req
	local.Model = model
	resp, err := p.Complete(ctx, &local)
	if err != nil {
		return nil, err
	}
	resp.Provider = p.Name()
	return resp, nil
}

// Stream executes a streaming chat completion.
func (c *Client) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	p, model, err := c.route(req.Model)
	if err != nil {
		return nil, err
	}
	local := *req
	local.Model = model
	local.Stream = true
	return p.Stream(ctx, &local)
}

// Embedding executes an embeddings request.
func (c *Client) Embedding(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	providerName, model := api.SplitModel(req.Model)
	p, err := c.Provider(providerName)
	if err != nil {
		return nil, err
	}
	local := *req
	local.Model = model
	return p.Embed(ctx, &local)
}

// Default is the shared client behind the package-level helpers.
var Default = New()

// Completion executes a chat completion on the default client.
func Completion(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	return Default.Completion(ctx, req)
}

// Stream executes a streaming chat completion on the default client.
func Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	return Default.Stream(ctx, req)
}

// Embedding executes an embeddings request on the default client.
func Embedding(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return Default.Embedding(ctx, req)
}
