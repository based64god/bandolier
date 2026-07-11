// Package nlpcloud implements the NLP Cloud adapter:
// POST https://api.nlpcloud.io/v1/gpu/{model}/generation with the chat folded
// into a single text (litellm does the same), authenticated with
// "Authorization: Token <key>". The generation endpoint has no streaming
// mode, so Stream is served as a single-chunk replay of Complete.
package nlpcloud

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

const defaultBase = "https://api.nlpcloud.io/v1/gpu"

func init() {
	api.Register("nlp_cloud", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
	api.RegisterAlias("nlpcloud", "nlp_cloud")
}

// Provider is an NLP Cloud adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func (p *Provider) Name() string { return "nlp_cloud" }

func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range []string{"NLP_CLOUD_API_KEY", "NLPCLOUD_API_KEY"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	return "", &api.Error{
		Type: api.ErrAuthentication, StatusCode: 401, Provider: "nlp_cloud",
		Message: "no API key for nlp_cloud: pass one or set NLP_CLOUD_API_KEY",
	}
}

func (p *Provider) endpoint(override, model string) string {
	base := p.cfg.BaseURL
	if base == "" {
		base = os.Getenv("NLP_CLOUD_API_BASE")
	}
	if override != "" {
		base = override
	}
	if base == "" {
		base = defaultBase
	}
	return strings.TrimRight(base, "/") + "/" + model + "/generation"
}

func prompt(messages []api.Message) string {
	parts := make([]string, 0, len(messages))
	for _, m := range messages {
		if text := m.Content.AsText(); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	key, err := p.key(req.APIKey)
	if err != nil {
		return nil, err
	}
	doc := map[string]any{"text": prompt(req.Messages)}
	if req.MaxTokens != nil {
		doc["max_length"] = *req.MaxTokens
	} else if req.MaxCompletionTokens != nil {
		doc["max_length"] = *req.MaxCompletionTokens
	}
	if req.Temperature != nil {
		doc["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		doc["top_p"] = *req.TopP
	}
	if len(req.Stop) > 0 {
		doc["stop_sequences"] = []string(req.Stop)
	}
	payload, err := json.Marshal(doc)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "nlp_cloud", Message: err.Error()}
	}

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint(req.BaseURL, req.Model), bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("nlp_cloud", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Token "+key)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("nlp_cloud", req.Model, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, api.ErrorFromHTTP("nlp_cloud", req.Model, resp.StatusCode, raw, 0)
	}

	var out struct {
		GeneratedText     string `json:"generated_text"`
		NbGeneratedTokens int    `json:"nb_generated_tokens"`
		NbInputTokens     int    `json:"nb_input_tokens"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "nlp_cloud",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	res := &api.ChatResponse{
		Object: "chat.completion", Created: time.Now().Unix(), Model: req.Model, Provider: "nlp_cloud",
		Choices: []api.Choice{{
			Message:      api.Message{Role: "assistant", Content: api.TextContent(out.GeneratedText)},
			FinishReason: "stop",
		}},
	}
	if out.NbInputTokens > 0 || out.NbGeneratedTokens > 0 {
		res.Usage = &api.Usage{
			PromptTokens:     out.NbInputTokens,
			CompletionTokens: out.NbGeneratedTokens,
			TotalTokens:      out.NbInputTokens + out.NbGeneratedTokens,
		}
	}
	return res, nil
}

// Stream replays a Complete as one content chunk plus a finish chunk — the
// generation endpoint has no native streaming.
func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	resp, err := p.Complete(ctx, req)
	if err != nil {
		return nil, err
	}
	content := ""
	if len(resp.Choices) > 0 {
		content = resp.Choices[0].Message.Content.AsText()
	}
	return api.SliceStream([]*api.ChatChunk{
		{
			ID: resp.ID, Object: "chat.completion.chunk", Created: resp.Created, Model: resp.Model,
			Choices: []api.ChunkChoice{{Delta: api.Delta{Role: "assistant", Content: content}}},
		},
		{
			ID: resp.ID, Object: "chat.completion.chunk", Created: resp.Created, Model: resp.Model,
			Choices: []api.ChunkChoice{{FinishReason: "stop"}},
			Usage:   resp.Usage,
		},
	}), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("nlp_cloud", "embeddings")
}
