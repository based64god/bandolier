// Package petals implements the Petals adapter against a swarm's HTTP
// endpoint (chat.petals.dev's POST /api/v1/generate, or a self-hosted
// equivalent named by PETALS_API_BASE): a form-encoded generate call
// returning {"ok": true, "outputs": "..."}. litellm's in-process mode (the
// petals Python library) has no wire protocol and thus no gollm equivalent.
// Streaming is served as a single-chunk replay (the swarm's streaming API is
// a websocket, out of scope).
package petals

import (
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

const defaultBase = "https://chat.petals.dev/api/v1/generate"

// defaultMaxNewTokens: the generate API requires max_new_tokens (litellm
// defaults it the same way).
const defaultMaxNewTokens = 256

func init() {
	api.Register("petals", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
}

// Provider is a Petals adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func (p *Provider) Name() string { return "petals" }

func (p *Provider) endpoint(override string) string {
	base := p.cfg.BaseURL
	if base == "" {
		base = os.Getenv("PETALS_API_BASE")
	}
	if override != "" {
		base = override
	}
	if base == "" {
		base = defaultBase
	}
	return strings.TrimRight(base, "/")
}

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

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	form := url.Values{
		"model":  {req.Model},
		"inputs": {prompt(req.Messages)},
	}
	maxNew := defaultMaxNewTokens
	if req.MaxTokens != nil {
		maxNew = *req.MaxTokens
	} else if req.MaxCompletionTokens != nil {
		maxNew = *req.MaxCompletionTokens
	}
	form.Set("max_new_tokens", strconv.Itoa(maxNew))
	if req.Temperature != nil {
		form.Set("do_sample", "1")
		form.Set("temperature", strconv.FormatFloat(*req.Temperature, 'f', -1, 64))
	}
	if req.TopP != nil {
		form.Set("top_p", strconv.FormatFloat(*req.TopP, 'f', -1, 64))
	}

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint(req.BaseURL), strings.NewReader(form.Encode()))
	if err != nil {
		return nil, api.WrapTransport("petals", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("petals", req.Model, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, api.ErrorFromHTTP("petals", req.Model, resp.StatusCode, raw, 0)
	}

	var out struct {
		OK        bool   `json:"ok"`
		Outputs   string `json:"outputs"`
		Traceback string `json:"traceback"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "petals",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	if !out.OK {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "petals",
			Model: req.Model, Message: "petals generate failed: " + firstLine(out.Traceback),
		}
	}
	return &api.ChatResponse{
		Object: "chat.completion", Created: time.Now().Unix(), Model: req.Model, Provider: "petals",
		Choices: []api.Choice{{
			Message:      api.Message{Role: "assistant", Content: api.TextContent(out.Outputs)},
			FinishReason: "stop",
		}},
	}, nil
}

func firstLine(s string) string {
	if s == "" {
		return "unknown error"
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// Stream replays a Complete as one content chunk plus a finish chunk.
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
			Object: "chat.completion.chunk", Created: resp.Created, Model: resp.Model,
			Choices: []api.ChunkChoice{{Delta: api.Delta{Role: "assistant", Content: content}}},
		},
		{
			Object: "chat.completion.chunk", Created: resp.Created, Model: resp.Model,
			Choices: []api.ChunkChoice{{FinishReason: "stop"}},
		},
	}), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("petals", "embeddings")
}
