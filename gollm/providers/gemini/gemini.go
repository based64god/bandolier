// Package gemini implements the Google AI Studio adapter
// (generativelanguage.googleapis.com). Gemini's wire format differs from the
// unified one in every dimension — contents/parts instead of messages,
// functionCall args as JSON objects instead of strings, camelCase
// generationConfig — so this adapter is a full bidirectional translation
// (see translate.go).
package gemini

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

const defaultBaseURL = "https://generativelanguage.googleapis.com/v1beta"

// Provider is a Google AI Studio Gemini adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func init() {
	api.Register("gemini", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
	api.RegisterAlias("google", "gemini")
}

func (p *Provider) Name() string { return "gemini" }

func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	return "", &api.Error{
		Type:       api.ErrAuthentication,
		StatusCode: 401,
		Provider:   "gemini",
		Message:    "no API key for gemini: pass one or set GEMINI_API_KEY or GOOGLE_API_KEY",
	}
}

func (p *Provider) baseURL(override string) string {
	base := defaultBaseURL
	if p.cfg.APIVersion != "" {
		base = "https://generativelanguage.googleapis.com/" + p.cfg.APIVersion
	}
	if p.cfg.BaseURL != "" {
		base = p.cfg.BaseURL
	}
	if override != "" {
		base = override
	}
	return strings.TrimRight(base, "/")
}

// modelPath normalizes a model id for URL building: callers sometimes pass
// the REST resource form ("models/gemini-...").
func modelPath(model string) string {
	return strings.TrimPrefix(model, "models/")
}

// do posts a Gemini API body and returns the raw response, translating
// non-2xx into classified errors. Auth is the x-goog-api-key header.
func (p *Provider) do(ctx context.Context, path, model, keyOverride, baseOverride string, headers map[string]string, body []byte) (*http.Response, error) {
	apiKey, err := p.key(keyOverride)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL(baseOverride)+path, bytes.NewReader(body))
	if err != nil {
		return nil, api.WrapTransport("gemini", model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-goog-api-key", apiKey)
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("gemini", model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("gemini", model, resp.StatusCode, raw, retryAfter(resp))
	}
	return resp, nil
}

func retryAfter(resp *http.Response) time.Duration {
	if v := resp.Header.Get("Retry-After"); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return 0
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	body, err := json.Marshal(requestToWire(req))
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "gemini", Model: req.Model, Message: err.Error()}
	}

	// Per-request timeout applies to the non-streaming call as a whole; for
	// streams it would sever long generations mid-flight, so Stream skips it.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	resp, err := p.do(ctx, "/models/"+modelPath(req.Model)+":generateContent",
		req.Model, req.APIKey, req.BaseURL, req.Headers, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var gr genResponse
	if err := json.NewDecoder(resp.Body).Decode(&gr); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "gemini",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	out := responseToUnified(req.Model, &gr)
	out.Provider = "gemini"
	return out, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	body, err := json.Marshal(requestToWire(req))
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "gemini", Model: req.Model, Message: err.Error()}
	}

	resp, err := p.do(ctx, "/models/"+modelPath(req.Model)+":streamGenerateContent?alt=sse",
		req.Model, req.APIKey, req.BaseURL, req.Headers, body)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	st := newStreamState(req.Model)
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport("gemini", req.Model, err)
			}
			if len(ev.Data) == 0 {
				continue
			}
			// Gemini interleaves {"error": ...} objects mid-stream on failure.
			if apiErr := sniffStreamError(req.Model, ev.Data); apiErr != nil {
				return nil, apiErr
			}
			var gr genResponse
			if err := json.Unmarshal(ev.Data, &gr); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: "gemini",
					Model: req.Model, Message: fmt.Sprintf("malformed stream chunk: %v", err),
				}
			}
			if chunk := st.chunk(&gr); chunk != nil {
				return chunk, nil
			}
		}
	}, resp.Body.Close), nil
}

// sniffStreamError detects an {"error": ...} payload in a stream.
func sniffStreamError(model string, data []byte) *api.Error {
	var probe struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &probe); err != nil || probe.Error == nil {
		return nil
	}
	status := probe.Error.Code
	if status == 0 {
		status = 500
	}
	return api.ErrorFromHTTP("gemini", model, status, data, 0)
}

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	if len(req.Input) == 0 {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "gemini", Model: req.Model, Message: "embeddings require at least one input"}
	}
	model := modelPath(req.Model)

	// Single input uses :embedContent (which reports usage); multiple inputs
	// use :batchEmbedContents (one request per input, model repeated in each).
	if len(req.Input) == 1 {
		body, _ := json.Marshal(embedContentRequest{
			Content:              content{Parts: []part{{Text: req.Input[0]}}},
			OutputDimensionality: req.Dimensions,
		})
		resp, err := p.do(ctx, "/models/"+model+":embedContent", req.Model, req.APIKey, req.BaseURL, req.Headers, body)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		var out embedContentResponse
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Embedding == nil {
			return nil, &api.Error{
				Type: api.ErrInternalServer, StatusCode: 502, Provider: "gemini",
				Model: req.Model, Message: fmt.Sprintf("malformed embedding response: %v", err),
			}
		}
		return &api.EmbeddingResponse{
			Object: "list",
			Model:  req.Model,
			Data:   []api.Embedding{{Object: "embedding", Index: 0, Embedding: out.Embedding.Values}},
			Usage:  usageToUnified(out.UsageMetadata),
		}, nil
	}

	batch := batchEmbedRequest{Requests: make([]embedContentRequest, 0, len(req.Input))}
	for _, in := range req.Input {
		batch.Requests = append(batch.Requests, embedContentRequest{
			Model:                "models/" + model,
			Content:              content{Parts: []part{{Text: in}}},
			OutputDimensionality: req.Dimensions,
		})
	}
	body, _ := json.Marshal(batch)
	resp, err := p.do(ctx, "/models/"+model+":batchEmbedContents", req.Model, req.APIKey, req.BaseURL, req.Headers, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out batchEmbedResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "gemini",
			Model: req.Model, Message: fmt.Sprintf("malformed embedding response: %v", err),
		}
	}
	unified := &api.EmbeddingResponse{Object: "list", Model: req.Model, Usage: usageToUnified(out.UsageMetadata)}
	for i, e := range out.Embeddings {
		unified.Data = append(unified.Data, api.Embedding{Object: "embedding", Index: i, Embedding: e.Values})
	}
	return unified, nil
}
