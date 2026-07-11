package ollama

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

func newProvider(t *testing.T, baseURL string) api.Provider {
	t.Helper()
	p, err := api.NewProvider("ollama", api.ProviderConfig{BaseURL: baseURL, APIKey: "test-key"})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	return p
}

const minimalChatBody = `{"model":"llama3.1","message":{"role":"assistant","content":"hi"},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":2}`

func TestAliasRegistration(t *testing.T) {
	name, ok := api.Resolve("ollama_chat")
	if !ok || name != "ollama" {
		t.Fatalf("Resolve(ollama_chat) = %q, %v; want ollama, true", name, ok)
	}
}

func TestCompleteRequestTranslation(t *testing.T) {
	var (
		gotPath string
		gotAuth string
		gotBody []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, minimalChatBody)
	}))
	defer srv.Close()

	temp, topP, maxTok, seed := 0.2, 0.9, 128, 42
	req := &api.ChatRequest{
		Model: "llama3.1",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be terse")},
			{Role: "user", Content: api.PartsContent(
				api.TextPart("what is this?"),
				api.ImagePart("data:image/png;base64,aGVsbG8="),
			)},
			{Role: "assistant", ToolCalls: []api.ToolCall{{
				ID: "call_abc", Type: "function",
				Function: api.ToolCallFunction{Name: "get_weather", Arguments: `{"city":"Paris"}`},
			}}},
			{Role: "tool", ToolCallID: "call_abc", Content: api.TextContent("sunny")},
		},
		Temperature:    &temp,
		TopP:           &topP,
		MaxTokens:      &maxTok,
		Seed:           &seed,
		Stop:           api.StringOrSlice{"END"},
		ResponseFormat: &api.ResponseFormat{Type: "json_object"},
		Tools: []api.Tool{{Type: "function", Function: api.ToolFunction{
			Name: "get_weather", Parameters: json.RawMessage(`{"type":"object"}`),
		}}},
		Extra: map[string]any{"keep_alive": "5m"},
	}
	if _, err := newProvider(t, srv.URL).Complete(context.Background(), req); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if gotPath != "/api/chat" {
		t.Errorf("path = %q, want /api/chat", gotPath)
	}
	if gotAuth != "Bearer test-key" {
		t.Errorf("Authorization = %q, want Bearer test-key", gotAuth)
	}

	var wire struct {
		Model     string           `json:"model"`
		Stream    *bool            `json:"stream"`
		Format    any              `json:"format"`
		Options   map[string]any   `json:"options"`
		Tools     []map[string]any `json:"tools"`
		KeepAlive string           `json:"keep_alive"`
		Messages  []struct {
			Role      string   `json:"role"`
			Content   string   `json:"content"`
			Images    []string `json:"images"`
			ToolName  string   `json:"tool_name"`
			ToolCalls []struct {
				Function struct {
					Name      string         `json:"name"`
					Arguments map[string]any `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(gotBody, &wire); err != nil {
		t.Fatalf("decode outbound body: %v\n%s", err, gotBody)
	}

	if wire.Model != "llama3.1" {
		t.Errorf("model = %q", wire.Model)
	}
	if wire.Stream == nil || *wire.Stream {
		t.Errorf("stream = %v, want explicit false", wire.Stream)
	}
	if wire.Format != "json" {
		t.Errorf("format = %v, want \"json\"", wire.Format)
	}
	if wire.KeepAlive != "5m" {
		t.Errorf("keep_alive = %q, want Extra passthrough 5m", wire.KeepAlive)
	}
	wantOpts := map[string]any{"temperature": 0.2, "top_p": 0.9, "num_predict": float64(128), "seed": float64(42)}
	for k, v := range wantOpts {
		if wire.Options[k] != v {
			t.Errorf("options[%s] = %v, want %v", k, wire.Options[k], v)
		}
	}
	if stop, ok := wire.Options["stop"].([]any); !ok || len(stop) != 1 || stop[0] != "END" {
		t.Errorf("options[stop] = %v, want [END]", wire.Options["stop"])
	}
	if len(wire.Tools) != 1 {
		t.Fatalf("tools = %v, want 1 entry", wire.Tools)
	}

	if len(wire.Messages) != 4 {
		t.Fatalf("messages = %d, want 4", len(wire.Messages))
	}
	if m := wire.Messages[0]; m.Role != "system" || m.Content != "be terse" {
		t.Errorf("system message = %+v", m)
	}
	if m := wire.Messages[1]; m.Content != "what is this?" || len(m.Images) != 1 || m.Images[0] != "aGVsbG8=" {
		t.Errorf("user message = %+v, want flattened text + bare-base64 image", m)
	}
	if m := wire.Messages[2]; len(m.ToolCalls) != 1 ||
		m.ToolCalls[0].Function.Name != "get_weather" ||
		m.ToolCalls[0].Function.Arguments["city"] != "Paris" {
		t.Errorf("assistant tool_calls = %+v, want decoded arguments object", m.ToolCalls)
	}
	if m := wire.Messages[3]; m.Role != "tool" || m.Content != "sunny" || m.ToolName != "get_weather" {
		t.Errorf("tool message = %+v, want tool_name resolved from history", m)
	}
}

func TestJSONSchemaFormat(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		io.WriteString(w, minimalChatBody)
	}))
	defer srv.Close()

	schema := json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"}}}`)
	req := &api.ChatRequest{
		Model:    "llama3.1",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		ResponseFormat: &api.ResponseFormat{
			Type:       "json_schema",
			JSONSchema: &api.JSONSchemaSpec{Name: "person", Schema: schema},
		},
	}
	if _, err := newProvider(t, srv.URL).Complete(context.Background(), req); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	var wire struct {
		Format map[string]any `json:"format"`
	}
	if err := json.Unmarshal(gotBody, &wire); err != nil {
		t.Fatalf("decode outbound body: %v", err)
	}
	if wire.Format["type"] != "object" {
		t.Errorf("format = %v, want the schema object itself", wire.Format)
	}
}

func TestCompleteResponseTranslation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"model":"llama3.1","message":{"role":"assistant","content":"","thinking":"pondering","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Paris"}}}]},"done":true,"done_reason":"stop","prompt_eval_count":11,"eval_count":7}`)
	}))
	defer srv.Close()

	resp, err := newProvider(t, srv.URL).Complete(context.Background(), &api.ChatRequest{
		Model:    "llama3.1",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("weather?")}},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if resp.Provider != "ollama" || resp.Object != "chat.completion" {
		t.Errorf("provider/object = %q/%q", resp.Provider, resp.Object)
	}
	if !strings.HasPrefix(resp.ID, "chatcmpl-") {
		t.Errorf("ID = %q, want synthesized chatcmpl- prefix", resp.ID)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("choices = %d, want 1", len(resp.Choices))
	}
	choice := resp.Choices[0]
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q, want tool_calls despite done_reason stop", choice.FinishReason)
	}
	if choice.Message.ReasoningContent != "pondering" {
		t.Errorf("reasoning = %q, want thinking mapped", choice.Message.ReasoningContent)
	}
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(choice.Message.ToolCalls))
	}
	tc := choice.Message.ToolCalls[0]
	if tc.ID != "call_0" || tc.Type != "function" || tc.Function.Name != "get_weather" {
		t.Errorf("tool call = %+v", tc)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil || args["city"] != "Paris" {
		t.Errorf("arguments = %q, want JSON string of the object", tc.Function.Arguments)
	}
	if resp.Usage == nil || resp.Usage.PromptTokens != 11 || resp.Usage.CompletionTokens != 7 || resp.Usage.TotalTokens != 18 {
		t.Errorf("usage = %+v, want 11/7/18", resp.Usage)
	}
}

func TestFinishReason(t *testing.T) {
	cases := []struct {
		doneReason string
		toolCalls  bool
		want       string
	}{
		{"stop", false, "stop"},
		{"", false, "stop"},
		{"length", false, "length"},
		{"stop", true, "tool_calls"},
		{"load", false, "load"},
	}
	for _, c := range cases {
		if got := finishReason(c.doneReason, c.toolCalls); got != c.want {
			t.Errorf("finishReason(%q, %v) = %q, want %q", c.doneReason, c.toolCalls, got, c.want)
		}
	}
}

func TestStream(t *testing.T) {
	lines := []string{
		`{"model":"llama3.1","message":{"role":"assistant","content":"","thinking":"hmm"},"done":false}`,
		`{"model":"llama3.1","message":{"role":"assistant","content":"Hel"},"done":false}`,
		`{"model":"llama3.1","message":{"role":"assistant","content":"lo"},"done":false}`,
		`{"model":"llama3.1","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Paris"}}}]},"done":false}`,
		`{"model":"llama3.1","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":9}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var wire map[string]any
		if err := json.Unmarshal(body, &wire); err != nil || wire["stream"] != true {
			t.Errorf("outbound stream flag = %v, want true", wire["stream"])
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		for _, l := range lines {
			io.WriteString(w, l+"\n")
		}
	}))
	defer srv.Close()

	stream, err := newProvider(t, srv.URL).Stream(context.Background(), &api.ChatRequest{
		Model:    "llama3.1",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	var chunks int
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		chunks++
		acc.Add(chunk)
	}
	if chunks != len(lines) {
		t.Errorf("chunks = %d, want %d", chunks, len(lines))
	}

	resp := acc.Response()
	if len(resp.Choices) != 1 {
		t.Fatalf("choices = %d, want 1", len(resp.Choices))
	}
	choice := resp.Choices[0]
	if got := choice.Message.Content.AsText(); got != "Hello" {
		t.Errorf("content = %q, want Hello", got)
	}
	if choice.Message.ReasoningContent != "hmm" {
		t.Errorf("reasoning = %q, want thinking deltas", choice.Message.ReasoningContent)
	}
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q, want tool_calls", choice.FinishReason)
	}
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %+v, want 1", choice.Message.ToolCalls)
	}
	tc := choice.Message.ToolCalls[0]
	if tc.ID != "call_0" || tc.Function.Name != "get_weather" {
		t.Errorf("tool call = %+v", tc)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil || args["city"] != "Paris" {
		t.Errorf("arguments = %q", tc.Function.Arguments)
	}
	if resp.Usage == nil || resp.Usage.PromptTokens != 5 || resp.Usage.CompletionTokens != 9 || resp.Usage.TotalTokens != 14 {
		t.Errorf("usage = %+v, want 5/9/14 from the done line", resp.Usage)
	}
}

// TestStreamUnterminatedFinalLine pins the bufio path that processes a final
// NDJSON line delivered alongside io.EOF (no trailing newline).
func TestStreamUnterminatedFinalLine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"model":"llama3.1","message":{"role":"assistant","content":"Hi"},"done":false}`+"\n")
		// Done line without a trailing newline.
		io.WriteString(w, `{"model":"llama3.1","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":1}`)
	}))
	defer srv.Close()

	stream, err := newProvider(t, srv.URL).Stream(context.Background(), &api.ChatRequest{
		Model:    "llama3.1",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	var chunks []*api.ChatChunk
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		chunks = append(chunks, chunk)
	}
	if len(chunks) != 2 {
		t.Fatalf("chunks = %d, want 2 (unterminated done line must still be emitted)", len(chunks))
	}
	last := chunks[1]
	if last.Choices[0].FinishReason != "stop" {
		t.Errorf("finish_reason = %q, want stop", last.Choices[0].FinishReason)
	}
	if last.Usage == nil || last.Usage.PromptTokens != 3 || last.Usage.CompletionTokens != 1 {
		t.Errorf("usage = %+v, want 3/1 from the unterminated done line", last.Usage)
	}
}

func TestStreamMidStreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"model":"llama3.1","message":{"role":"assistant","content":"par"},"done":false}`+"\n")
		io.WriteString(w, `{"error":"model runner crashed"}`+"\n")
	}))
	defer srv.Close()

	stream, err := newProvider(t, srv.URL).Stream(context.Background(), &api.ChatRequest{
		Model:    "llama3.1",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	if _, err := stream.Recv(); err != nil {
		t.Fatalf("first Recv: %v", err)
	}
	_, err = stream.Recv()
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrInternalServer || apiErr.Message != "model runner crashed" {
		t.Fatalf("second Recv err = %v, want internal_server_error with ollama message", err)
	}
}

func TestErrorMapping(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   api.ErrorType
	}{
		{404, `{"error":"model \"nope\" not found, try pulling it first"}`, api.ErrNotFound},
		{400, `{"error":"invalid options"}`, api.ErrBadRequest},
		{500, `{"error":"something exploded"}`, api.ErrInternalServer},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(c.status)
			io.WriteString(w, c.body)
		}))
		_, err := newProvider(t, srv.URL).Complete(context.Background(), &api.ChatRequest{
			Model:    "nope",
			Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		})
		srv.Close()

		apiErr, ok := api.AsError(err)
		if !ok {
			t.Fatalf("status %d: err = %v, want *api.Error", c.status, err)
		}
		if apiErr.Type != c.want || apiErr.StatusCode != c.status || apiErr.Provider != "ollama" {
			t.Errorf("status %d: got %v/%d/%s, want %v", c.status, apiErr.Type, apiErr.StatusCode, apiErr.Provider, c.want)
		}
	}
}

func TestEmbed(t *testing.T) {
	var (
		gotPath string
		gotBody []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		io.WriteString(w, `{"model":"nomic-embed-text","embeddings":[[0.1,0.2],[0.3,0.4]],"prompt_eval_count":6}`)
	}))
	defer srv.Close()

	resp, err := newProvider(t, srv.URL).Embed(context.Background(), &api.EmbeddingRequest{
		Model: "nomic-embed-text",
		Input: api.StringOrSlice{"a", "b"},
	})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}

	if gotPath != "/api/embed" {
		t.Errorf("path = %q, want /api/embed", gotPath)
	}
	var wire struct {
		Model string   `json:"model"`
		Input []string `json:"input"`
	}
	if err := json.Unmarshal(gotBody, &wire); err != nil {
		t.Fatalf("decode outbound body: %v", err)
	}
	if wire.Model != "nomic-embed-text" || len(wire.Input) != 2 || wire.Input[0] != "a" || wire.Input[1] != "b" {
		t.Errorf("outbound = %+v, want input array form", wire)
	}

	if resp.Object != "list" || len(resp.Data) != 2 {
		t.Fatalf("response = %+v, want list of 2", resp)
	}
	if resp.Data[1].Index != 1 || resp.Data[1].Object != "embedding" || resp.Data[1].Embedding[0] != 0.3 {
		t.Errorf("data[1] = %+v", resp.Data[1])
	}
	if resp.Usage == nil || resp.Usage.PromptTokens != 6 || resp.Usage.TotalTokens != 6 {
		t.Errorf("usage = %+v, want prompt_eval_count 6", resp.Usage)
	}
}

// TestBaseURLEnvFallback exercises the OLLAMA_HOST fallback and the http://
// prefixing of a bare host:port, plus keyless requests sending no
// Authorization header.
func TestBaseURLEnvFallback(t *testing.T) {
	var gotAuth *string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		gotAuth = &auth
		io.WriteString(w, minimalChatBody)
	}))
	defer srv.Close()

	t.Setenv("OLLAMA_API_BASE", "")
	t.Setenv("OLLAMA_HOST", strings.TrimPrefix(srv.URL, "http://"))
	t.Setenv("OLLAMA_API_KEY", "")

	p, err := api.NewProvider("ollama", api.ProviderConfig{})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "llama3.1",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatalf("Complete via OLLAMA_HOST: %v", err)
	}
	if gotAuth == nil || *gotAuth != "" {
		t.Errorf("Authorization = %v, want none without a key", gotAuth)
	}
}

func TestNormalizeBase(t *testing.T) {
	cases := map[string]string{
		"example.com:11434":         "http://example.com:11434",
		"http://localhost:11434/":   "http://localhost:11434",
		"https://ollama.internal":   "https://ollama.internal",
		"  10.0.0.5:11434  ":        "http://10.0.0.5:11434",
		"https://host/ollama/base/": "https://host/ollama/base",
	}
	for in, want := range cases {
		if got := normalizeBase(in); got != want {
			t.Errorf("normalizeBase(%q) = %q, want %q", in, got, want)
		}
	}
}
