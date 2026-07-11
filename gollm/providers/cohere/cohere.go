// Package cohere implements the Cohere v2 API adapter (POST /v2/chat,
// POST /v2/embed). v2 is near-OpenAI — messages, tools, and tool_calls reuse
// the unified shapes — so translation is limited to Cohere's parameter names
// (p, stop_sequences), its tool-result content blocks, its uppercase finish
// reasons, and its typed streaming events.
package cohere

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

const defaultBaseURL = "https://api.cohere.com"

// Provider is a Cohere v2 adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func init() {
	api.Register("cohere", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
	api.RegisterAlias("cohere_chat", "cohere")
}

func (p *Provider) Name() string { return "cohere" }

// key resolves the credential: per-request override, configured key, then
// COHERE_API_KEY / CO_API_KEY (Cohere's own SDK convention).
func (p *Provider) key(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey, nil
	}
	for _, env := range []string{"COHERE_API_KEY", "CO_API_KEY"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	return "", &api.Error{
		Type:       api.ErrAuthentication,
		StatusCode: 401,
		Provider:   "cohere",
		Message:    "no API key for cohere: pass one or set COHERE_API_KEY or CO_API_KEY",
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
	return strings.TrimRight(base, "/")
}

// ── wire types ───────────────────────────────────────────────────────────────

// chatRequest is the /v2/chat body. Tools keep the OpenAI function shape
// verbatim; parameters use Cohere's names.
type chatRequest struct {
	Model            string     `json:"model"`
	Messages         []message  `json:"messages"`
	Tools            []api.Tool `json:"tools,omitempty"`
	Temperature      *float64   `json:"temperature,omitempty"`
	P                *float64   `json:"p,omitempty"`
	MaxTokens        *int       `json:"max_tokens,omitempty"`
	StopSequences    []string   `json:"stop_sequences,omitempty"`
	Seed             *int       `json:"seed,omitempty"`
	FrequencyPenalty *float64   `json:"frequency_penalty,omitempty"`
	PresencePenalty  *float64   `json:"presence_penalty,omitempty"`
	Stream           bool       `json:"stream,omitempty"`
}

// message is one v2 chat turn. Content is polymorphic: unified content
// (string or OpenAI-shaped parts) on user/system/assistant turns, or
// []textBlock on tool turns (v2 requires block-array tool results).
type message struct {
	Role       string         `json:"role"`
	Content    any            `json:"content,omitempty"`
	ToolCalls  []api.ToolCall `json:"tool_calls,omitempty"`
	ToolPlan   string         `json:"tool_plan,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
}

type textBlock struct {
	Type string `json:"type"` // "text"
	Text string `json:"text"`
}

// chatResponse is the /v2/chat non-streaming envelope.
type chatResponse struct {
	ID           string       `json:"id"`
	FinishReason string       `json:"finish_reason"`
	Message      assistantMsg `json:"message"`
	Usage        *usage       `json:"usage"`
}

type assistantMsg struct {
	Role      string         `json:"role"`
	Content   []textBlock    `json:"content"`
	ToolCalls []api.ToolCall `json:"tool_calls"`
	ToolPlan  string         `json:"tool_plan"`
}

// usage carries both accounting views Cohere reports; tokens (raw model
// tokens) is preferred over billed_units, matching litellm.
type usage struct {
	BilledUnits *tokenCounts `json:"billed_units"`
	Tokens      *tokenCounts `json:"tokens"`
}

// tokenCounts are float64 on Cohere's wire.
type tokenCounts struct {
	InputTokens  float64 `json:"input_tokens"`
	OutputTokens float64 `json:"output_tokens"`
}

func (u *usage) toUnified() *api.Usage {
	if u == nil {
		return nil
	}
	tc := u.Tokens
	if tc == nil {
		tc = u.BilledUnits
	}
	if tc == nil {
		return nil
	}
	in, out := int(tc.InputTokens), int(tc.OutputTokens)
	return &api.Usage{PromptTokens: in, CompletionTokens: out, TotalTokens: in + out}
}

// ── translation ──────────────────────────────────────────────────────────────

// requestFromUnified builds the wire request; unified fields Cohere doesn't
// support (n, tool_choice, logit_bias, response_format, ...) drop silently.
func requestFromUnified(req *api.ChatRequest) *chatRequest {
	out := &chatRequest{
		Model:            req.Model,
		Messages:         messagesFromUnified(req.Messages),
		Tools:            req.Tools,
		Temperature:      req.Temperature,
		P:                req.TopP,
		StopSequences:    req.Stop,
		Seed:             req.Seed,
		FrequencyPenalty: req.FrequencyPenalty,
		PresencePenalty:  req.PresencePenalty,
	}
	// max_completion_tokens is the newer OpenAI spelling; it wins.
	switch {
	case req.MaxCompletionTokens != nil:
		out.MaxTokens = req.MaxCompletionTokens
	case req.MaxTokens != nil:
		out.MaxTokens = req.MaxTokens
	}
	return out
}

func messagesFromUnified(msgs []api.Message) []message {
	out := make([]message, 0, len(msgs))
	for _, m := range msgs {
		switch m.Role {
		case "system", "developer":
			out = append(out, message{Role: "system", Content: m.Content.AsText()})
		case "tool":
			out = append(out, message{
				Role:       "tool",
				ToolCallID: m.ToolCallID,
				Content:    []textBlock{{Type: "text", Text: m.Content.AsText()}},
			})
		case "assistant":
			am := message{
				Role:      "assistant",
				ToolCalls: outboundToolCalls(m.ToolCalls),
				// tool_plan is Cohere's pre-tool-call reasoning slot, the
				// closest wire field to a reasoning trace.
				ToolPlan: m.ReasoningContent,
			}
			if !m.Content.IsZero() {
				am.Content = m.Content
			}
			out = append(out, am)
		default: // user, or roles Cohere has no concept of
			um := message{Role: "user"}
			if !m.Content.IsZero() {
				um.Content = m.Content
			}
			out = append(out, um)
		}
	}
	return out
}

// outboundToolCalls strips the stream-only Index field from replayed history.
func outboundToolCalls(tcs []api.ToolCall) []api.ToolCall {
	if len(tcs) == 0 {
		return nil
	}
	out := make([]api.ToolCall, len(tcs))
	for i, tc := range tcs {
		typ := tc.Type
		if typ == "" {
			typ = "function"
		}
		out[i] = api.ToolCall{ID: tc.ID, Type: typ, Function: tc.Function}
	}
	return out
}

// marshalBody renders the wire request, merging Extra verbatim (Extra wins on
// collision — the same contract as api.ChatRequest.MarshalJSON).
func marshalBody(wire *chatRequest, extra map[string]any) ([]byte, error) {
	base, err := json.Marshal(wire)
	if err != nil || len(extra) == 0 {
		return base, err
	}
	var m map[string]any
	if err := json.Unmarshal(base, &m); err != nil {
		return nil, err
	}
	for k, v := range extra {
		m[k] = v
	}
	return json.Marshal(m)
}

// finishReason maps Cohere's uppercase reasons onto OpenAI's vocabulary.
// ERROR and anything unrecognized degrade to "stop".
func finishReason(r string) string {
	switch strings.ToUpper(r) {
	case "MAX_TOKENS":
		return "length"
	case "TOOL_CALL":
		return "tool_calls"
	default: // COMPLETE, STOP_SEQUENCE, ERROR, ...
		return "stop"
	}
}

func responseToUnified(cr *chatResponse, model string) *api.ChatResponse {
	msg := api.Message{Role: "assistant", ReasoningContent: cr.Message.ToolPlan}
	var text strings.Builder
	for _, b := range cr.Message.Content {
		if b.Type == "text" {
			text.WriteString(b.Text)
		}
	}
	if text.Len() > 0 {
		msg.Content = api.TextContent(text.String())
	}
	for _, tc := range cr.Message.ToolCalls {
		typ := tc.Type
		if typ == "" {
			typ = "function"
		}
		msg.ToolCalls = append(msg.ToolCalls, api.ToolCall{ID: tc.ID, Type: typ, Function: tc.Function})
	}
	return &api.ChatResponse{
		ID:       cr.ID,
		Object:   "chat.completion",
		Created:  time.Now().Unix(),
		Model:    model,
		Provider: "cohere",
		Choices: []api.Choice{{
			Index:        0,
			Message:      msg,
			FinishReason: finishReason(cr.FinishReason),
		}},
		Usage: cr.Usage.toUnified(),
	}
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

func (p *Provider) do(ctx context.Context, path string, body []byte, model, keyOverride, baseOverride string, headers map[string]string) (*http.Response, error) {
	apiKey, err := p.key(keyOverride)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL(baseOverride)+path, bytes.NewReader(body))
	if err != nil {
		return nil, api.WrapTransport("cohere", model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("cohere", model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("cohere", model, resp.StatusCode, raw, retryAfter(resp))
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
	wire := requestFromUnified(req)
	wire.Stream = false
	body, err := marshalBody(wire, req.Extra)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "cohere", Model: req.Model, Message: err.Error()}
	}

	// Per-request timeout applies to the non-streaming call as a whole; for
	// streams it would sever long generations mid-flight, so Stream skips it.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	resp, err := p.do(ctx, "/v2/chat", body, req.Model, req.APIKey, req.BaseURL, req.Headers)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var cr chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "cohere",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	return responseToUnified(&cr, req.Model), nil
}

// ── streaming ────────────────────────────────────────────────────────────────

// streamEvent is any v2 stream event; the event kind is the JSON "type" field
// (the SSE event name duplicates it). Content and ToolCalls stay raw because
// their JSON type varies by event (arrays on message-start, objects on
// content-delta / tool-call-*).
type streamEvent struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Delta struct {
		Message struct {
			Content   json.RawMessage `json:"content"`
			ToolPlan  string          `json:"tool_plan"`
			ToolCalls json.RawMessage `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
		Usage        *usage `json:"usage"`
	} `json:"delta"`
}

// wireToolCall is the single-object tool_calls payload on tool-call-start and
// tool-call-delta events.
type wireToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	wire := requestFromUnified(req)
	wire.Stream = true
	body, err := marshalBody(wire, req.Extra)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "cohere", Model: req.Model, Message: err.Error()}
	}

	resp, err := p.do(ctx, "/v2/chat", body, req.Model, req.APIKey, req.BaseURL, req.Headers)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	var (
		id      string
		created = time.Now().Unix()
		toolIdx = -1 // OpenAI tool index, advanced on each tool-call-start
		done    bool
	)
	chunk := func(choice api.ChunkChoice) *api.ChatChunk {
		return &api.ChatChunk{
			ID:      id,
			Object:  "chat.completion.chunk",
			Created: created,
			Model:   req.Model,
			Choices: []api.ChunkChoice{choice},
		}
	}
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
				return nil, api.WrapTransport("cohere", req.Model, err)
			}
			if len(ev.Data) == 0 || ev.IsDone() {
				continue
			}
			var sev streamEvent
			if err := json.Unmarshal(ev.Data, &sev); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: "cohere",
					Model: req.Model, Message: fmt.Sprintf("malformed stream event: %v", err),
				}
			}
			typ := sev.Type
			if typ == "" {
				typ = ev.Name
			}

			switch typ {
			case "message-start":
				if sev.ID != "" {
					id = sev.ID
				}
				return chunk(api.ChunkChoice{Delta: api.Delta{Role: "assistant"}}), nil

			case "content-delta":
				var content struct {
					Text string `json:"text"`
				}
				_ = json.Unmarshal(sev.Delta.Message.Content, &content)
				return chunk(api.ChunkChoice{Delta: api.Delta{Content: content.Text}}), nil

			case "tool-plan-delta":
				return chunk(api.ChunkChoice{Delta: api.Delta{ReasoningContent: sev.Delta.Message.ToolPlan}}), nil

			case "tool-call-start":
				toolIdx++
				var tc wireToolCall
				_ = json.Unmarshal(sev.Delta.Message.ToolCalls, &tc)
				idx := toolIdx
				return chunk(api.ChunkChoice{Delta: api.Delta{ToolCalls: []api.ToolCall{{
					Index: &idx,
					ID:    tc.ID,
					Type:  "function",
					Function: api.ToolCallFunction{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				}}}}), nil

			case "tool-call-delta":
				var tc wireToolCall
				_ = json.Unmarshal(sev.Delta.Message.ToolCalls, &tc)
				idx := toolIdx
				if idx < 0 { // fragment before any start; anchor at 0
					idx = 0
				}
				return chunk(api.ChunkChoice{Delta: api.Delta{ToolCalls: []api.ToolCall{{
					Index:    &idx,
					Function: api.ToolCallFunction{Arguments: tc.Function.Arguments},
				}}}}), nil

			case "message-end":
				done = true
				out := chunk(api.ChunkChoice{FinishReason: finishReason(sev.Delta.FinishReason)})
				out.Usage = sev.Delta.Usage.toUnified()
				return out, nil

			default:
				// content-start/-end, tool-call-end, citation-*, debug: nothing
				// to surface in OpenAI chunk form.
				continue
			}
		}
	}, resp.Body.Close), nil
}

// ── embeddings ───────────────────────────────────────────────────────────────

// embedRequest is the /v2/embed body. Float embeddings are always requested:
// the unified response type is [][]float64.
type embedRequest struct {
	Model           string   `json:"model"`
	Texts           []string `json:"texts"`
	InputType       string   `json:"input_type"`
	EmbeddingTypes  []string `json:"embedding_types"`
	OutputDimension *int     `json:"output_dimension,omitempty"`
}

type embedResponse struct {
	ID         string `json:"id"`
	Embeddings struct {
		Float [][]float64 `json:"float"`
	} `json:"embeddings"`
	Meta struct {
		BilledUnits struct {
			InputTokens float64 `json:"input_tokens"`
		} `json:"billed_units"`
	} `json:"meta"`
}

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	wire := embedRequest{
		Model: req.Model,
		Texts: req.Input,
		// input_type is required by v2; search_document is litellm's default
		// for storage-oriented embedding calls.
		InputType:       "search_document",
		EmbeddingTypes:  []string{"float"},
		OutputDimension: req.Dimensions,
	}
	body, err := json.Marshal(wire)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "cohere", Model: req.Model, Message: err.Error()}
	}

	resp, err := p.do(ctx, "/v2/embed", body, req.Model, req.APIKey, req.BaseURL, req.Headers)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var er embedResponse
	if err := json.NewDecoder(resp.Body).Decode(&er); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "cohere",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}

	out := &api.EmbeddingResponse{Object: "list", Model: req.Model}
	for i, v := range er.Embeddings.Float {
		out.Data = append(out.Data, api.Embedding{Object: "embedding", Index: i, Embedding: v})
	}
	if t := int(er.Meta.BilledUnits.InputTokens); t > 0 {
		out.Usage = &api.Usage{PromptTokens: t, TotalTokens: t}
	}
	return out, nil
}
