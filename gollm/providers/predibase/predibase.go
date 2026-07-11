// Package predibase implements the Predibase adapter: TGI-style
// /generate and /generate_stream endpoints under a tenant's serving base
// ({base}/{tenant}/deployments/v2/llms/{model}). Chat messages fold into a
// single prompt; responses carry generated_text plus TGI token details.
package predibase

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

const defaultBase = "https://serving.app.predibase.com"

// defaultMaxNewTokens: TGI requires max_new_tokens; litellm defaults it too.
const defaultMaxNewTokens = 256

func init() {
	api.Register("predibase", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
}

// Provider is a Predibase adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func (p *Provider) Name() string { return "predibase" }

func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	if v := os.Getenv("PREDIBASE_API_KEY"); v != "" {
		return v, nil
	}
	return "", &api.Error{
		Type: api.ErrAuthentication, StatusCode: 401, Provider: "predibase",
		Message: "no API key for predibase: pass one or set PREDIBASE_API_KEY",
	}
}

func (p *Provider) tenant() (string, error) {
	if v := p.cfg.Extra["tenant_id"]; v != "" {
		return v, nil
	}
	if v := os.Getenv("PREDIBASE_TENANT_ID"); v != "" {
		return v, nil
	}
	return "", &api.Error{
		Type: api.ErrBadRequest, StatusCode: 400, Provider: "predibase",
		Message: "no Predibase tenant: set PREDIBASE_TENANT_ID (or Extra tenant_id)",
	}
}

func (p *Provider) endpoint(override, model string, stream bool) (string, error) {
	base := p.cfg.BaseURL
	if base == "" {
		base = os.Getenv("PREDIBASE_API_BASE")
	}
	if override != "" {
		base = override
	}
	if base == "" {
		base = defaultBase
	}
	tenant, err := p.tenant()
	if err != nil {
		return "", err
	}
	action := "generate"
	if stream {
		action = "generate_stream"
	}
	return fmt.Sprintf("%s/%s/deployments/v2/llms/%s/%s", strings.TrimRight(base, "/"), tenant, model, action), nil
}

// prompt folds chat messages into TGI's single input.
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
	params := map[string]any{"max_new_tokens": defaultMaxNewTokens, "details": true}
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
	if len(req.Stop) > 0 {
		params["stop"] = []string(req.Stop)
	}
	return json.Marshal(map[string]any{"inputs": prompt(req.Messages), "parameters": params})
}

func (p *Provider) do(ctx context.Context, req *api.ChatRequest, stream bool) (*http.Response, error) {
	u, err := p.endpoint(req.BaseURL, req.Model, stream)
	if err != nil {
		return nil, err
	}
	key, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	payload, err := body(req)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "predibase", Message: err.Error()}
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("predibase", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+key)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("predibase", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("predibase", req.Model, resp.StatusCode, raw, 0)
	}
	return resp, nil
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
		GeneratedText string `json:"generated_text"`
		Details       struct {
			FinishReason    string `json:"finish_reason"`
			GeneratedTokens int    `json:"generated_tokens"`
			PromptTokens    int    `json:"prompt_tokens"`
		} `json:"details"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "predibase",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}

	finish := "stop"
	if out.Details.FinishReason == "length" {
		finish = "length"
	}
	res := &api.ChatResponse{
		Object: "chat.completion", Created: time.Now().Unix(), Model: req.Model, Provider: "predibase",
		Choices: []api.Choice{{
			Message:      api.Message{Role: "assistant", Content: api.TextContent(out.GeneratedText)},
			FinishReason: finish,
		}},
	}
	if d := out.Details; d.GeneratedTokens > 0 || d.PromptTokens > 0 {
		res.Usage = &api.Usage{
			PromptTokens:     d.PromptTokens,
			CompletionTokens: d.GeneratedTokens,
			TotalTokens:      d.PromptTokens + d.GeneratedTokens,
		}
	}
	return res, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	resp, err := p.do(ctx, req, true)
	if err != nil {
		return nil, err
	}

	// TGI SSE chunks: {"token": {"text": ...}, "generated_text": null|full,
	// "details": {...}} — generated_text non-null marks the final chunk.
	sse := api.NewSSEReader(resp.Body)
	created := time.Now().Unix()
	sentRole := false
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		ev, err := sse.Next()
		if err != nil {
			if err == io.EOF {
				return nil, io.EOF
			}
			return nil, api.WrapTransport("predibase", req.Model, err)
		}
		var out struct {
			Token struct {
				Text string `json:"text"`
			} `json:"token"`
			GeneratedText *string `json:"generated_text"`
			Details       *struct {
				FinishReason string `json:"finish_reason"`
			} `json:"details"`
		}
		_ = json.Unmarshal(ev.Data, &out)

		delta := api.Delta{Content: out.Token.Text}
		if !sentRole {
			delta.Role = "assistant"
			sentRole = true
		}
		chunk := &api.ChatChunk{
			Object: "chat.completion.chunk", Created: created, Model: req.Model,
			Choices: []api.ChunkChoice{{Delta: delta}},
		}
		if out.GeneratedText != nil {
			finish := "stop"
			if out.Details != nil && out.Details.FinishReason == "length" {
				finish = "length"
			}
			chunk.Choices[0].FinishReason = finish
		}
		return chunk, nil
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("predibase", "embeddings")
}
