// Package triton implements the NVIDIA Triton Inference Server adapter for
// its text-generation extension: POST …/generate ({"text_input": prompt} →
// {"text_output": …}) and …/generate_stream (SSE). The endpoint comes from
// TRITON_API_BASE — either the server root (the model name completes the
// path: /v2/models/<model>/generate) or a full …/generate URL. Triton's
// tensor-level /infer protocol is not supported.
package triton

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

func init() {
	api.Register("triton", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
}

// Provider is a Triton adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func (p *Provider) Name() string { return "triton" }

// endpoint resolves the generate URL for a model.
func (p *Provider) endpoint(override, model string, stream bool) (string, error) {
	base := p.cfg.BaseURL
	if base == "" {
		base = os.Getenv("TRITON_API_BASE")
	}
	if override != "" {
		base = override
	}
	if base == "" {
		return "", &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: "triton",
			Message: "no endpoint for triton: set TRITON_API_BASE (server root or a full /v2/models/<model>/generate URL)",
		}
	}
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/infer") {
		return "", &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: "triton",
			Message: "triton /infer (tensor protocol) is not supported; point TRITON_API_BASE at a /generate endpoint",
		}
	}
	if !strings.HasSuffix(base, "/generate") {
		base = fmt.Sprintf("%s/v2/models/%s/generate", base, model)
	}
	if stream {
		base += "_stream"
	}
	return base, nil
}

// prompt folds chat messages into Triton's single text input.
func prompt(messages []api.Message) string {
	var b strings.Builder
	for _, m := range messages {
		if text := m.Content.AsText(); text != "" {
			b.WriteString(text)
			b.WriteString("\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func body(req *api.ChatRequest) ([]byte, error) {
	params := map[string]any{}
	if req.MaxTokens != nil {
		params["max_tokens"] = *req.MaxTokens
	} else if req.MaxCompletionTokens != nil {
		params["max_tokens"] = *req.MaxCompletionTokens
	}
	if req.Temperature != nil {
		params["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		params["top_p"] = *req.TopP
	}
	doc := map[string]any{"text_input": prompt(req.Messages), "parameters": params}
	for k, v := range req.Extra {
		doc[k] = v
	}
	return json.Marshal(doc)
}

func (p *Provider) do(ctx context.Context, req *api.ChatRequest, stream bool) (*http.Response, error) {
	u, err := p.endpoint(req.BaseURL, req.Model, stream)
	if err != nil {
		return nil, err
	}
	payload, err := body(req)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "triton", Message: err.Error()}
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("triton", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// Triton is usually unauthenticated; honor a key if one is supplied.
	if key := firstNonEmpty(req.APIKey, p.cfg.APIKey, os.Getenv("TRITON_API_KEY")); key != "" {
		httpReq.Header.Set("Authorization", "Bearer "+key)
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("triton", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("triton", req.Model, resp.StatusCode, raw, 0)
	}
	return resp, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	resp, err := p.do(ctx, req, false)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out struct {
		TextOutput string `json:"text_output"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "triton",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	return &api.ChatResponse{
		Object: "chat.completion", Created: time.Now().Unix(), Model: req.Model, Provider: "triton",
		Choices: []api.Choice{{
			Message:      api.Message{Role: "assistant", Content: api.TextContent(out.TextOutput)},
			FinishReason: "stop",
		}},
	}, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	resp, err := p.do(ctx, req, true)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	created := time.Now().Unix()
	sentRole := false
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		ev, err := sse.Next()
		if err != nil {
			if err == io.EOF {
				return nil, io.EOF
			}
			return nil, api.WrapTransport("triton", req.Model, err)
		}
		var out struct {
			TextOutput string `json:"text_output"`
		}
		_ = json.Unmarshal(ev.Data, &out)
		delta := api.Delta{Content: out.TextOutput}
		if !sentRole {
			delta.Role = "assistant"
			sentRole = true
		}
		return &api.ChatChunk{
			Object: "chat.completion.chunk", Created: created, Model: req.Model,
			Choices: []api.ChunkChoice{{Delta: delta}},
		}, nil
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("triton", "embeddings")
}
