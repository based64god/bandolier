// Package bytez implements the Bytez model-API adapter:
// POST https://api.bytez.com/models/v2/{model} with {"messages", "params",
// "stream"}, authenticated with "Authorization: Key <key>". Non-streaming
// responses arrive as {"error", "output"}; streaming responses are raw text
// chunks (not SSE — litellm needs a custom stream wrapper for the same
// reason).
package bytez

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

const defaultBase = "https://api.bytez.com/models/v2"

func init() {
	api.Register("bytez", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
}

// Provider is a Bytez adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func (p *Provider) Name() string { return "bytez" }

func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range []string{"BYTEZ_API_KEY", "BYTEZ_KEY"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	return "", &api.Error{
		Type: api.ErrAuthentication, StatusCode: 401, Provider: "bytez",
		Message: "no API key for bytez: pass one or set BYTEZ_API_KEY",
	}
}

func (p *Provider) endpoint(override, model string) string {
	base := p.cfg.BaseURL
	if base == "" {
		base = os.Getenv("BYTEZ_API_BASE")
	}
	if override != "" {
		base = override
	}
	if base == "" {
		base = defaultBase
	}
	return strings.TrimRight(base, "/") + "/" + model
}

func body(req *api.ChatRequest, stream bool) ([]byte, error) {
	messages := make([]map[string]string, 0, len(req.Messages))
	for _, m := range req.Messages {
		messages = append(messages, map[string]string{"role": m.Role, "content": m.Content.AsText()})
	}
	params := map[string]any{}
	if req.MaxTokens != nil {
		params["max_new_tokens"] = *req.MaxTokens
	} else if req.MaxCompletionTokens != nil {
		params["max_new_tokens"] = *req.MaxCompletionTokens
	}
	if req.Temperature != nil {
		params["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		params["top_p"] = *req.TopP
	}
	return json.Marshal(map[string]any{"messages": messages, "params": params, "stream": stream})
}

func (p *Provider) do(ctx context.Context, req *api.ChatRequest, stream bool) (*http.Response, error) {
	key, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	payload, err := body(req, stream)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "bytez", Message: err.Error()}
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint(req.BaseURL, req.Model), bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("bytez", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Key "+key)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("bytez", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("bytez", req.Model, resp.StatusCode, raw, 0)
	}
	return resp, nil
}

// outputText renders Bytez's polymorphic output: a plain string, a message
// object with content, or a list of message objects.
func outputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var msg struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(raw, &msg) == nil && msg.Content != "" {
		return msg.Content
	}
	var msgs []struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(raw, &msgs) == nil {
		var b strings.Builder
		for _, m := range msgs {
			b.WriteString(m.Content)
		}
		return b.String()
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
		Error  any             `json:"error"`
		Output json.RawMessage `json:"output"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "bytez",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	if out.Error != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "bytez",
			Model: req.Model, Message: fmt.Sprintf("bytez error: %v", out.Error),
		}
	}
	return &api.ChatResponse{
		Object: "chat.completion", Created: time.Now().Unix(), Model: req.Model, Provider: "bytez",
		Choices: []api.Choice{{
			Message:      api.Message{Role: "assistant", Content: api.TextContent(outputText(out.Output))},
			FinishReason: "stop",
		}},
	}, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	resp, err := p.do(ctx, req, true)
	if err != nil {
		return nil, err
	}

	// The stream is raw text chunks, not SSE.
	created := time.Now().Unix()
	sentRole := false
	finished := false
	buf := make([]byte, 4096)
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		if finished {
			return nil, io.EOF
		}
		n, err := resp.Body.Read(buf)
		if n > 0 {
			delta := api.Delta{Content: string(buf[:n])}
			if !sentRole {
				delta.Role = "assistant"
				sentRole = true
			}
			return &api.ChatChunk{
				Object: "chat.completion.chunk", Created: created, Model: req.Model,
				Choices: []api.ChunkChoice{{Delta: delta}},
			}, nil
		}
		if err == io.EOF {
			finished = true
			return &api.ChatChunk{
				Object: "chat.completion.chunk", Created: created, Model: req.Model,
				Choices: []api.ChunkChoice{{FinishReason: "stop"}},
			}, nil
		}
		if err != nil {
			return nil, api.WrapTransport("bytez", req.Model, err)
		}
		return &api.ChatChunk{Object: "chat.completion.chunk", Created: created, Model: req.Model}, nil
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("bytez", "embeddings")
}
