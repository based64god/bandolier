// Package replicate implements the Replicate adapter. Replicate's API is
// prediction-based, not chat-based: a POST creates a prediction from a
// text prompt, whose output is fetched by polling (non-streaming) or over an
// SSE stream. Chat messages are folded into a single prompt; tool calling is
// not part of the surface. Model strings follow litellm's forms:
//
//	replicate/owner/name                      → POST /models/owner/name/predictions
//	replicate/owner/name:versionhash          → POST /predictions {"version": ...}
//	replicate/deployments/owner/name          → POST /deployments/owner/name/predictions
package replicate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

const defaultBase = "https://api.replicate.com/v1"

// pollInterval paces the prediction status polls (litellm uses 500ms).
const pollInterval = 500 * time.Millisecond

func init() {
	api.Register("replicate", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
}

// Provider is a Replicate adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func (p *Provider) Name() string { return "replicate" }

func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range []string{"REPLICATE_API_TOKEN", "REPLICATE_API_KEY"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	return "", &api.Error{
		Type: api.ErrAuthentication, StatusCode: 401, Provider: "replicate",
		Message: "no API key for replicate: pass one or set REPLICATE_API_TOKEN",
	}
}

func (p *Provider) base(override string) string {
	base := defaultBase
	if v := os.Getenv("REPLICATE_API_BASE"); v != "" {
		base = v
	}
	if p.cfg.BaseURL != "" {
		base = p.cfg.BaseURL
	}
	if override != "" {
		base = override
	}
	return strings.TrimRight(base, "/")
}

// createURL routes the model string to its prediction-creation endpoint; the
// second return is the pinned version hash for the {"version": ...} form.
func createURL(base, model string) (u, version string) {
	if rest, ok := strings.CutPrefix(model, "deployments/"); ok {
		return base + "/deployments/" + rest + "/predictions", ""
	}
	if name, ver, ok := strings.Cut(model, ":"); ok {
		_ = name
		return base + "/predictions", ver
	}
	return base + "/models/" + model + "/predictions", ""
}

// prompt folds the chat history into a single text prompt (Replicate models
// take text, not messages).
func prompt(messages []api.Message) string {
	var b strings.Builder
	for _, m := range messages {
		text := m.Content.AsText()
		if text == "" {
			continue
		}
		switch m.Role {
		case "system":
			b.WriteString(text + "\n\n")
		case "assistant":
			b.WriteString("Assistant: " + text + "\n")
		default:
			b.WriteString("User: " + text + "\n")
		}
	}
	b.WriteString("Assistant: ")
	return b.String()
}

// prediction is the subset of Replicate's prediction document we consume.
type prediction struct {
	ID     string          `json:"id"`
	Status string          `json:"status"` // starting | processing | succeeded | failed | canceled
	Output json.RawMessage `json:"output"` // string or []string
	Error  any             `json:"error"`
	URLs   struct {
		Get    string `json:"get"`
		Stream string `json:"stream"`
	} `json:"urls"`
	Metrics struct {
		InputTokenCount  int `json:"input_token_count"`
		OutputTokenCount int `json:"output_token_count"`
	} `json:"metrics"`
}

// outputText joins a prediction output (a string or a list of string
// fragments) into one text.
func outputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []string
	if json.Unmarshal(raw, &parts) == nil {
		return strings.Join(parts, "")
	}
	return ""
}

// create posts a new prediction.
func (p *Provider) create(ctx context.Context, req *api.ChatRequest, stream bool) (*prediction, error) {
	key, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}

	input := map[string]any{"prompt": prompt(req.Messages)}
	if req.MaxTokens != nil {
		input["max_new_tokens"] = *req.MaxTokens
	} else if req.MaxCompletionTokens != nil {
		input["max_new_tokens"] = *req.MaxCompletionTokens
	}
	if req.Temperature != nil {
		input["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		input["top_p"] = *req.TopP
	}
	if len(req.Stop) > 0 {
		input["stop_sequences"] = strings.Join(req.Stop, ",")
	}
	for k, v := range req.Extra {
		input[k] = v
	}

	u, version := createURL(p.base(req.BaseURL), req.Model)
	body := map[string]any{"input": input}
	if version != "" {
		body["version"] = version
	}
	if stream {
		body["stream"] = true
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "replicate", Message: err.Error()}
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("replicate", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+key)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("replicate", req.Model, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, api.ErrorFromHTTP("replicate", req.Model, resp.StatusCode, raw, 0)
	}
	var pred prediction
	if err := json.Unmarshal(raw, &pred); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "replicate",
			Model: req.Model, Message: fmt.Sprintf("malformed prediction: %v", err),
		}
	}
	return &pred, nil
}

// get fetches a prediction's current state.
func (p *Provider) get(ctx context.Context, req *api.ChatRequest, url string) (*prediction, error) {
	key, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, api.WrapTransport("replicate", req.Model, err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+key)

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("replicate", req.Model, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, api.ErrorFromHTTP("replicate", req.Model, resp.StatusCode, raw, 0)
	}
	var pred prediction
	if err := json.Unmarshal(raw, &pred); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "replicate",
			Model: req.Model, Message: fmt.Sprintf("malformed prediction: %v", err),
		}
	}
	return &pred, nil
}

func terminal(status string) bool {
	return status == "succeeded" || status == "failed" || status == "canceled"
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	pred, err := p.create(ctx, req, false)
	if err != nil {
		return nil, err
	}
	// Poll responses don't necessarily repeat `urls`; the creation response's
	// polling URL is authoritative.
	getURL := pred.URLs.Get
	if getURL == "" && !terminal(pred.Status) {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "replicate",
			Model: req.Model, Message: "prediction has no polling URL",
		}
	}
	for !terminal(pred.Status) {
		select {
		case <-ctx.Done():
			return nil, api.WrapTransport("replicate", req.Model, ctx.Err())
		case <-time.After(pollInterval):
		}
		pred, err = p.get(ctx, req, getURL)
		if err != nil {
			return nil, err
		}
	}
	if pred.Status != "succeeded" {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "replicate",
			Model: req.Model, Message: fmt.Sprintf("prediction %s: %v", pred.Status, pred.Error),
		}
	}

	resp := &api.ChatResponse{
		ID:       pred.ID,
		Object:   "chat.completion",
		Created:  time.Now().Unix(),
		Model:    req.Model,
		Provider: "replicate",
		Choices: []api.Choice{{
			Message:      api.Message{Role: "assistant", Content: api.TextContent(outputText(pred.Output))},
			FinishReason: "stop",
		}},
	}
	if in, out := pred.Metrics.InputTokenCount, pred.Metrics.OutputTokenCount; in > 0 || out > 0 {
		resp.Usage = &api.Usage{PromptTokens: in, CompletionTokens: out, TotalTokens: in + out}
	}
	return resp, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	pred, err := p.create(ctx, req, true)
	if err != nil {
		return nil, err
	}
	if pred.URLs.Stream == "" {
		return nil, &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: "replicate",
			Model: req.Model, Message: "model does not support streaming (no stream URL on the prediction)",
		}
	}

	key, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, pred.URLs.Stream, nil)
	if err != nil {
		return nil, api.WrapTransport("replicate", req.Model, err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+key)
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Cache-Control", "no-store")

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("replicate", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("replicate", req.Model, resp.StatusCode, raw, 0)
	}

	// Replicate's SSE stream: `event: output` carries a text fragment,
	// `event: done` ends the prediction, `event: error` carries a failure.
	sse := api.NewSSEReader(resp.Body)
	created := time.Now().Unix()
	sentRole := false
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport("replicate", req.Model, err)
			}
			switch ev.Name {
			case "output":
				delta := api.Delta{Content: string(ev.Data)}
				if !sentRole {
					delta.Role = "assistant"
					sentRole = true
				}
				return &api.ChatChunk{
					ID: pred.ID, Object: "chat.completion.chunk", Created: created, Model: req.Model,
					Choices: []api.ChunkChoice{{Delta: delta}},
				}, nil
			case "done":
				return &api.ChatChunk{
					ID: pred.ID, Object: "chat.completion.chunk", Created: created, Model: req.Model,
					Choices: []api.ChunkChoice{{FinishReason: "stop"}},
				}, nil
			case "error":
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: "replicate",
					Model: req.Model, Message: string(ev.Data),
				}
			default:
				continue
			}
		}
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("replicate", "embeddings")
}
