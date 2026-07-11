// Package ollama implements the native Ollama API adapter (local models):
// POST /api/chat for completions and POST /api/embed for embeddings. Unlike
// the OpenAI-compatible endpoint Ollama also exposes, the native API streams
// newline-delimited JSON (not SSE), carries tool-call arguments as JSON
// objects (not strings), and reports usage as prompt_eval_count/eval_count —
// this adapter translates all of that to and from the unified format.
package ollama

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
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

const defaultBaseURL = "http://localhost:11434"

// Provider is a native Ollama API adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func init() {
	api.Register("ollama", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
	// litellm splits ollama (prompt-template /api/generate) from ollama_chat
	// (/api/chat); this adapter always speaks /api/chat, so both names map here.
	api.RegisterAlias("ollama_chat", "ollama")
}

func (p *Provider) Name() string { return "ollama" }

// key resolves the optional credential. Local Ollama has no auth, so absence
// is not an error; hosted deployments may gate with a bearer token, which is
// sent when configured.
func (p *Provider) key(override string) string {
	if override != "" {
		return override
	}
	if p.cfg.APIKey != "" {
		return p.cfg.APIKey
	}
	return os.Getenv("OLLAMA_API_KEY")
}

// baseURL resolves the endpoint: per-request override, configured base, then
// OLLAMA_API_BASE / OLLAMA_HOST, then the local default.
func (p *Provider) baseURL(override string) string {
	base := override
	if base == "" {
		base = p.cfg.BaseURL
	}
	if base == "" {
		base = os.Getenv("OLLAMA_API_BASE")
	}
	if base == "" {
		base = os.Getenv("OLLAMA_HOST")
	}
	if base == "" {
		base = defaultBaseURL
	}
	return normalizeBase(base)
}

// normalizeBase prefixes a scheme when missing — OLLAMA_HOST is conventionally
// a bare host:port (the ollama CLI's own format).
func normalizeBase(base string) string {
	base = strings.TrimSpace(base)
	if base != "" && !strings.Contains(base, "://") {
		base = "http://" + base
	}
	return strings.TrimRight(base, "/")
}

// ── Ollama wire types ──

// chatRequest is the POST /api/chat body. Stream has no omitempty on purpose:
// Ollama defaults to streaming, so stream:false must be explicit.
type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
	Tools    []api.Tool    `json:"tools,omitempty"`
	// Format is the JSON string "json" (json_object) or a schema object
	// (json_schema → Ollama structured outputs).
	Format  json.RawMessage `json:"format,omitempty"`
	Options map[string]any  `json:"options,omitempty"`
}

// chatMessage is Ollama's message shape, shared by requests and responses.
type chatMessage struct {
	Role      string         `json:"role"`
	Content   string         `json:"content"`
	Thinking  string         `json:"thinking,omitempty"`
	Images    []string       `json:"images,omitempty"` // bare base64, no data: URI
	ToolCalls []wireToolCall `json:"tool_calls,omitempty"`
	// ToolName names the function a tool-role result answers; Ollama has no
	// tool_call_id correlation.
	ToolName string `json:"tool_name,omitempty"`
}

type wireToolCall struct {
	Function wireToolFunction `json:"function"`
}

// wireToolFunction carries arguments as a JSON object, not OpenAI's string.
type wireToolFunction struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// chatResponse is one /api/chat body: the whole response when stream:false,
// or one NDJSON line when streaming ({"done":true} on the last, which carries
// done_reason and the token counts).
type chatResponse struct {
	Model           string       `json:"model"`
	Message         *chatMessage `json:"message"`
	Done            bool         `json:"done"`
	DoneReason      string       `json:"done_reason"`
	PromptEvalCount int          `json:"prompt_eval_count"`
	EvalCount       int          `json:"eval_count"`
	// Err is Ollama's failure shape ({"error":"..."}), which can also arrive
	// mid-stream on a 200.
	Err string `json:"error"`
}

type embedRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embedResponse struct {
	Model           string      `json:"model"`
	Embeddings      [][]float64 `json:"embeddings"`
	PromptEvalCount int         `json:"prompt_eval_count"`
}

// ── Request translation ──

func (p *Provider) wireRequest(req *api.ChatRequest, stream bool) ([]byte, error) {
	// ToolChoice is deliberately dropped: litellm found it hangs Ollama.
	// Other unsupported knobs (n, penalties, logit_bias, ...) drop silently
	// per the drop_params doctrine.
	wire := chatRequest{
		Model:    req.Model,
		Messages: wireMessages(req.Messages),
		Stream:   stream,
		Tools:    req.Tools,
		Format:   wireFormat(req.ResponseFormat),
		Options:  wireOptions(req),
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	if len(req.Extra) == 0 {
		return payload, nil
	}
	// Extra merges at the top level of the native body (the api.ChatRequest
	// Extra contract): "think", "keep_alive", an options override, ...
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil, err
	}
	for k, v := range req.Extra {
		m[k] = v
	}
	return json.Marshal(m)
}

func wireMessages(msgs []api.Message) []chatMessage {
	// Resolve tool_call_id → function name from prior assistant turns so
	// tool results can carry tool_name.
	names := map[string]string{}
	for _, m := range msgs {
		for _, tc := range m.ToolCalls {
			if tc.ID != "" && tc.Function.Name != "" {
				names[tc.ID] = tc.Function.Name
			}
		}
	}

	out := make([]chatMessage, 0, len(msgs))
	for _, m := range msgs {
		wm := chatMessage{
			Role:     m.Role,
			Content:  m.Content.AsText(),
			Thinking: m.ReasoningContent,
		}
		for _, part := range m.Content.Parts {
			if part.Type == "image_url" && part.ImageURL != nil {
				wm.Images = append(wm.Images, imageData(part.ImageURL.URL))
			}
		}
		for _, tc := range m.ToolCalls {
			wm.ToolCalls = append(wm.ToolCalls, wireToolCall{
				Function: wireToolFunction{
					Name:      tc.Function.Name,
					Arguments: argumentsObject(tc.Function.Arguments),
				},
			})
		}
		if m.Role == "tool" {
			wm.ToolName = names[m.ToolCallID]
		}
		out = append(out, wm)
	}
	return out
}

// imageData strips a data: URI down to its base64 payload (Ollama takes bare
// base64); anything else passes through untouched, mirroring litellm's
// best-effort fallback.
func imageData(url string) string {
	if !strings.HasPrefix(url, "data:") {
		return url
	}
	if i := strings.IndexByte(url, ','); i >= 0 {
		return url[i+1:]
	}
	return url
}

// argumentsObject re-encodes an OpenAI arguments JSON string as the object
// Ollama expects; empty or malformed arguments degrade to {}.
func argumentsObject(args string) json.RawMessage {
	trimmed := strings.TrimSpace(args)
	if trimmed == "" || !json.Valid([]byte(trimmed)) {
		return json.RawMessage("{}")
	}
	return json.RawMessage(trimmed)
}

func wireFormat(rf *api.ResponseFormat) json.RawMessage {
	if rf == nil {
		return nil
	}
	switch rf.Type {
	case "json_object":
		return json.RawMessage(`"json"`)
	case "json_schema":
		if rf.JSONSchema != nil && len(rf.JSONSchema.Schema) > 0 {
			return rf.JSONSchema.Schema
		}
	}
	return nil
}

func wireOptions(req *api.ChatRequest) map[string]any {
	opts := map[string]any{}
	if req.Temperature != nil {
		opts["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		opts["top_p"] = *req.TopP
	}
	switch {
	case req.MaxTokens != nil:
		opts["num_predict"] = *req.MaxTokens
	case req.MaxCompletionTokens != nil:
		opts["num_predict"] = *req.MaxCompletionTokens
	}
	if len(req.Stop) > 0 {
		opts["stop"] = []string(req.Stop)
	}
	if req.Seed != nil {
		opts["seed"] = *req.Seed
	}
	if len(opts) == 0 {
		return nil
	}
	return opts
}

// ── Transport ──

func (p *Provider) do(ctx context.Context, path, model, keyOverride, baseOverride string, headers map[string]string, payload []byte) (*http.Response, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL(baseOverride)+path, bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("ollama", model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if key := p.key(keyOverride); key != "" {
		httpReq.Header.Set("Authorization", "Bearer "+key)
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("ollama", model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("ollama", model, resp.StatusCode, raw, retryAfter(resp))
	}
	return resp, nil
}

// retryAfter parses the Retry-After header (seconds form only).
func retryAfter(resp *http.Response) time.Duration {
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	return 0
}

// ── Completions ──

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	payload, err := p.wireRequest(req, false)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "ollama", Model: req.Model, Message: err.Error()}
	}

	// Per-request timeout applies to the non-streaming call as a whole; for
	// streams it would sever long generations mid-flight, so Stream skips it.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	resp, err := p.do(ctx, "/api/chat", req.Model, req.APIKey, req.BaseURL, req.Headers, payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var native chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&native); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "ollama",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	if native.Err != "" {
		return nil, &api.Error{Type: api.ErrInternalServer, StatusCode: 500, Provider: "ollama", Model: req.Model, Message: native.Err}
	}
	return responseToUnified(&native, req.Model), nil
}

func responseToUnified(native *chatResponse, reqModel string) *api.ChatResponse {
	msg := api.Message{Role: "assistant"}
	if native.Message != nil {
		if native.Message.Role != "" {
			msg.Role = native.Message.Role
		}
		msg.Content = api.TextContent(native.Message.Content)
		msg.ReasoningContent = native.Message.Thinking
		msg.ToolCalls = unifiedToolCalls(native.Message.ToolCalls, 0, false)
	}
	return &api.ChatResponse{
		ID:      newID(),
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   modelOr(native.Model, reqModel),
		Choices: []api.Choice{{
			Message:      msg,
			FinishReason: finishReason(native.DoneReason, len(msg.ToolCalls) > 0),
		}},
		Usage: &api.Usage{
			PromptTokens:     native.PromptEvalCount,
			CompletionTokens: native.EvalCount,
			TotalTokens:      native.PromptEvalCount + native.EvalCount,
		},
		Provider: "ollama",
	}
}

// unifiedToolCalls converts native calls, synthesizing ids ("call_<n>") since
// Ollama sends none and re-encoding arguments objects as OpenAI JSON strings.
// start numbers calls across a whole stream; withIndex adds the delta index
// stream consumers correlate by.
func unifiedToolCalls(calls []wireToolCall, start int, withIndex bool) []api.ToolCall {
	out := make([]api.ToolCall, 0, len(calls))
	for i, c := range calls {
		n := start + i
		args := string(c.Function.Arguments)
		if args == "" || args == "null" {
			args = "{}"
		}
		tc := api.ToolCall{
			ID:       fmt.Sprintf("call_%d", n),
			Type:     "function",
			Function: api.ToolCallFunction{Name: c.Function.Name, Arguments: args},
		}
		if withIndex {
			idx := n
			tc.Index = &idx
		}
		out = append(out, tc)
	}
	return out
}

// finishReason maps done_reason; a turn that produced tool calls reports
// tool_calls regardless (Ollama says "stop" for those too).
func finishReason(doneReason string, toolCalls bool) string {
	if toolCalls {
		return "tool_calls"
	}
	switch doneReason {
	case "", "stop":
		return "stop"
	case "length":
		return "length"
	default:
		return doneReason
	}
}

// newID synthesizes an OpenAI-style completion id; Ollama responses carry none.
func newID() string {
	var b [12]byte
	rand.Read(b[:]) // never fails (crypto/rand contract)
	return "chatcmpl-" + hex.EncodeToString(b[:])
}

func modelOr(model, fallback string) string {
	if model != "" {
		return model
	}
	return fallback
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	payload, err := p.wireRequest(req, true)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "ollama", Model: req.Model, Message: err.Error()}
	}
	resp, err := p.do(ctx, "/api/chat", req.Model, req.APIKey, req.BaseURL, req.Headers, payload)
	if err != nil {
		return nil, err
	}

	// The native stream is newline-delimited JSON, one chatResponse per line.
	reader := bufio.NewReaderSize(resp.Body, 64<<10)
	var (
		id           = newID()
		created      = time.Now().Unix()
		nextToolIdx  int  // numbers synthesized tool calls across the stream
		sawToolCalls bool // any tool call ⇒ finish_reason tool_calls
		done         bool
	)
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			if done {
				return nil, io.EOF
			}
			line, err := reader.ReadBytes('\n')
			line = bytes.TrimSpace(line)
			if len(line) == 0 {
				if err == io.EOF {
					return nil, io.EOF
				}
				if err != nil {
					return nil, api.WrapTransport("ollama", req.Model, err)
				}
				continue
			}
			// A line delivered alongside io.EOF (missing final newline) is
			// still processed; the next Recv hits the bare EOF above.

			var native chatResponse
			if err := json.Unmarshal(line, &native); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: "ollama",
					Model: req.Model, Message: fmt.Sprintf("malformed stream line: %v", err),
				}
			}
			if native.Err != "" {
				return nil, &api.Error{Type: api.ErrInternalServer, StatusCode: 500, Provider: "ollama", Model: req.Model, Message: native.Err}
			}

			var delta api.Delta
			if native.Message != nil {
				delta.Role = native.Message.Role
				delta.Content = native.Message.Content
				delta.ReasoningContent = native.Message.Thinking
				delta.ToolCalls = unifiedToolCalls(native.Message.ToolCalls, nextToolIdx, true)
				nextToolIdx += len(delta.ToolCalls)
				if len(delta.ToolCalls) > 0 {
					sawToolCalls = true
				}
			}
			chunk := &api.ChatChunk{
				ID:      id,
				Object:  "chat.completion.chunk",
				Created: created,
				Model:   modelOr(native.Model, req.Model),
				Choices: []api.ChunkChoice{{Delta: delta}},
			}
			if native.Done {
				done = true
				chunk.Choices[0].FinishReason = finishReason(native.DoneReason, sawToolCalls)
				chunk.Usage = &api.Usage{
					PromptTokens:     native.PromptEvalCount,
					CompletionTokens: native.EvalCount,
					TotalTokens:      native.PromptEvalCount + native.EvalCount,
				}
			}
			return chunk, nil
		}
	}, resp.Body.Close), nil
}

// ── Embeddings ──

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	input := make([]string, len(req.Input))
	copy(input, req.Input)
	payload, err := json.Marshal(embedRequest{Model: req.Model, Input: input})
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "ollama", Model: req.Model, Message: err.Error()}
	}

	resp, err := p.do(ctx, "/api/embed", req.Model, req.APIKey, req.BaseURL, req.Headers, payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var native embedResponse
	if err := json.NewDecoder(resp.Body).Decode(&native); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "ollama",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}

	out := &api.EmbeddingResponse{
		Object: "list",
		Model:  modelOr(native.Model, req.Model),
		Usage: &api.Usage{
			PromptTokens: native.PromptEvalCount,
			TotalTokens:  native.PromptEvalCount,
		},
	}
	for i, e := range native.Embeddings {
		out.Data = append(out.Data, api.Embedding{Object: "embedding", Index: i, Embedding: e})
	}
	return out, nil
}
