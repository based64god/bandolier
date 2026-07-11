package cohere

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

const minimalChatResponse = `{
	"id": "resp_min",
	"finish_reason": "COMPLETE",
	"message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
	"usage": {"tokens": {"input_tokens": 1, "output_tokens": 1}}
}`

// newProvider builds a cohere provider through the registry, pointed at a
// fake server.
func newProvider(t *testing.T, handler http.HandlerFunc) api.Provider {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	p, err := api.NewProvider("cohere", api.ProviderConfig{BaseURL: srv.URL, APIKey: "test-key"})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	return p
}

func TestAliasRegistration(t *testing.T) {
	canonical, ok := api.Resolve("cohere_chat")
	if !ok || canonical != "cohere" {
		t.Fatalf("Resolve(cohere_chat) = %q, %v; want cohere, true", canonical, ok)
	}
}

func TestCompleteRequestTranslation(t *testing.T) {
	var (
		gotPath string
		gotAuth string
		gotBody map[string]any
	)
	p := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &gotBody); err != nil {
			t.Errorf("request body not JSON: %v", err)
		}
		io.WriteString(w, minimalChatResponse)
	})

	temp, topP := 0.7, 0.9
	maxTok, seed := 512, 42
	req := &api.ChatRequest{
		Model: "command-r-plus",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be brief")},
			{Role: "user", Content: api.TextContent("weather in Paris?")},
			{Role: "assistant", ReasoningContent: "checking the weather", ToolCalls: []api.ToolCall{{
				ID: "call_1", Type: "function",
				Function: api.ToolCallFunction{Name: "get_weather", Arguments: `{"city":"Paris"}`},
			}}},
			{Role: "tool", ToolCallID: "call_1", Content: api.TextContent("18C, sunny")},
		},
		Temperature: &temp,
		TopP:        &topP,
		MaxTokens:   &maxTok,
		Seed:        &seed,
		Stop:        api.StringOrSlice{"END"},
		Tools: []api.Tool{{Type: "function", Function: api.ToolFunction{
			Name:        "get_weather",
			Description: "Get current weather",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"city":{"type":"string"}}}`),
		}}},
		Extra: map[string]any{"k": 5},
	}
	if _, err := p.Complete(context.Background(), req); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if gotPath != "/v2/chat" {
		t.Errorf("path = %q, want /v2/chat", gotPath)
	}
	if gotAuth != "Bearer test-key" {
		t.Errorf("Authorization = %q, want Bearer test-key", gotAuth)
	}
	if gotBody["model"] != "command-r-plus" {
		t.Errorf("model = %v", gotBody["model"])
	}
	if gotBody["temperature"] != 0.7 || gotBody["p"] != 0.9 {
		t.Errorf("temperature/p = %v/%v, want 0.7/0.9", gotBody["temperature"], gotBody["p"])
	}
	if gotBody["max_tokens"] != float64(512) || gotBody["seed"] != float64(42) {
		t.Errorf("max_tokens/seed = %v/%v", gotBody["max_tokens"], gotBody["seed"])
	}
	if !reflect.DeepEqual(gotBody["stop_sequences"], []any{"END"}) {
		t.Errorf("stop_sequences = %v, want [END]", gotBody["stop_sequences"])
	}
	if gotBody["k"] != float64(5) {
		t.Errorf("Extra param k = %v, want 5", gotBody["k"])
	}
	if _, present := gotBody["stream"]; present {
		t.Errorf("stream sent on non-streaming request: %v", gotBody["stream"])
	}

	msgs := gotBody["messages"].([]any)
	if len(msgs) != 4 {
		t.Fatalf("messages len = %d, want 4", len(msgs))
	}
	sys := msgs[0].(map[string]any)
	if sys["role"] != "system" || sys["content"] != "be brief" {
		t.Errorf("system message = %v", sys)
	}
	user := msgs[1].(map[string]any)
	if user["role"] != "user" || user["content"] != "weather in Paris?" {
		t.Errorf("user message = %v", user)
	}
	asst := msgs[2].(map[string]any)
	if asst["role"] != "assistant" || asst["tool_plan"] != "checking the weather" {
		t.Errorf("assistant message = %v", asst)
	}
	if _, present := asst["content"]; present {
		t.Errorf("tool-call-only assistant message has content: %v", asst["content"])
	}
	atc := asst["tool_calls"].([]any)[0].(map[string]any)
	if atc["id"] != "call_1" || atc["type"] != "function" {
		t.Errorf("assistant tool_call = %v", atc)
	}
	fn := atc["function"].(map[string]any)
	if fn["name"] != "get_weather" || fn["arguments"] != `{"city":"Paris"}` {
		t.Errorf("assistant tool_call function = %v", fn)
	}
	tool := msgs[3].(map[string]any)
	if tool["role"] != "tool" || tool["tool_call_id"] != "call_1" {
		t.Errorf("tool message = %v", tool)
	}
	wantToolContent := []any{map[string]any{"type": "text", "text": "18C, sunny"}}
	if !reflect.DeepEqual(tool["content"], wantToolContent) {
		t.Errorf("tool content = %v, want %v", tool["content"], wantToolContent)
	}

	toolDecl := gotBody["tools"].([]any)[0].(map[string]any)
	if toolDecl["type"] != "function" {
		t.Errorf("tool type = %v", toolDecl["type"])
	}
	declFn := toolDecl["function"].(map[string]any)
	if declFn["name"] != "get_weather" || declFn["description"] != "Get current weather" {
		t.Errorf("tool function = %v", declFn)
	}
	if _, ok := declFn["parameters"].(map[string]any); !ok {
		t.Errorf("tool parameters = %v", declFn["parameters"])
	}
}

func TestCompleteResponseTranslation(t *testing.T) {
	p := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{
			"id": "resp_42",
			"finish_reason": "TOOL_CALL",
			"message": {
				"role": "assistant",
				"content": [{"type": "text", "text": "Let me "}, {"type": "text", "text": "check."}],
				"tool_plan": "I will call get_weather.",
				"tool_calls": [{"id": "call_9", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}}]
			},
			"usage": {
				"billed_units": {"input_tokens": 5, "output_tokens": 7},
				"tokens": {"input_tokens": 50, "output_tokens": 70}
			}
		}`)
	})

	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "command-r-plus",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if resp.ID != "resp_42" || resp.Object != "chat.completion" || resp.Model != "command-r-plus" {
		t.Errorf("envelope = %q/%q/%q", resp.ID, resp.Object, resp.Model)
	}
	if resp.Provider != "cohere" {
		t.Errorf("Provider = %q", resp.Provider)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("choices = %d, want 1", len(resp.Choices))
	}
	c := resp.Choices[0]
	if c.FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q, want tool_calls", c.FinishReason)
	}
	if got := c.Message.Content.AsText(); got != "Let me check." {
		t.Errorf("content = %q", got)
	}
	if c.Message.ReasoningContent != "I will call get_weather." {
		t.Errorf("reasoning (tool_plan) = %q", c.Message.ReasoningContent)
	}
	if len(c.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(c.Message.ToolCalls))
	}
	tc := c.Message.ToolCalls[0]
	if tc.ID != "call_9" || tc.Type != "function" || tc.Function.Name != "get_weather" ||
		tc.Function.Arguments != `{"city":"Paris"}` {
		t.Errorf("tool call = %+v", tc)
	}
	// usage.tokens wins over billed_units.
	want := &api.Usage{PromptTokens: 50, CompletionTokens: 70, TotalTokens: 120}
	if !reflect.DeepEqual(resp.Usage, want) {
		t.Errorf("usage = %+v, want %+v", resp.Usage, want)
	}
}

func TestFinishReasonMapping(t *testing.T) {
	for cohereReason, want := range map[string]string{
		"COMPLETE":      "stop",
		"STOP_SEQUENCE": "stop",
		"MAX_TOKENS":    "length",
		"TOOL_CALL":     "tool_calls",
		"ERROR":         "stop",
		"":              "stop",
	} {
		if got := finishReason(cohereReason); got != want {
			t.Errorf("finishReason(%q) = %q, want %q", cohereReason, got, want)
		}
	}
}

const streamFixture = `event: message-start
data: {"id":"run_1","type":"message-start","delta":{"message":{"role":"assistant","content":[],"tool_plan":"","tool_calls":[]}}}

event: content-start
data: {"type":"content-start","index":0,"delta":{"message":{"content":{"type":"text","text":""}}}}

event: content-delta
data: {"type":"content-delta","index":0,"delta":{"message":{"content":{"text":"Hello"}}}}

event: content-delta
data: {"type":"content-delta","index":0,"delta":{"message":{"content":{"text":", world"}}}}

event: content-end
data: {"type":"content-end","index":0}

event: tool-plan-delta
data: {"type":"tool-plan-delta","delta":{"message":{"tool_plan":"I'll check two things."}}}

event: tool-call-start
data: {"type":"tool-call-start","index":1,"delta":{"message":{"tool_calls":{"id":"call_a","type":"function","function":{"name":"get_weather","arguments":""}}}}}

event: tool-call-delta
data: {"type":"tool-call-delta","index":1,"delta":{"message":{"tool_calls":{"function":{"arguments":"{\"city\":"}}}}}

event: tool-call-delta
data: {"type":"tool-call-delta","index":1,"delta":{"message":{"tool_calls":{"function":{"arguments":"\"Paris\"}"}}}}}

event: tool-call-end
data: {"type":"tool-call-end","index":1}

event: tool-call-start
data: {"type":"tool-call-start","index":2,"delta":{"message":{"tool_calls":{"id":"call_b","type":"function","function":{"name":"get_time","arguments":""}}}}}

event: tool-call-delta
data: {"type":"tool-call-delta","index":2,"delta":{"message":{"tool_calls":{"function":{"arguments":"{}"}}}}}

event: tool-call-end
data: {"type":"tool-call-end","index":2}

event: message-end
data: {"type":"message-end","id":"run_1","delta":{"finish_reason":"TOOL_CALL","usage":{"billed_units":{"input_tokens":10,"output_tokens":20},"tokens":{"input_tokens":12,"output_tokens":25}}}}

`

func TestStream(t *testing.T) {
	var gotBody map[string]any
	p := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &gotBody); err != nil {
			t.Errorf("request body not JSON: %v", err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, streamFixture)
	})

	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "command-r-plus",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	if gotBody["stream"] != true {
		t.Errorf("stream = %v, want true", gotBody["stream"])
	}

	acc := api.NewStreamAccumulator()
	var (
		chunks      []*api.ChatChunk
		toolIndices []int
	)
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		chunks = append(chunks, chunk)
		acc.Add(chunk)
		for _, cc := range chunk.Choices {
			for _, tc := range cc.Delta.ToolCalls {
				if tc.Index == nil {
					t.Fatalf("streamed tool call without index: %+v", tc)
				}
				toolIndices = append(toolIndices, *tc.Index)
			}
		}
	}
	if _, err := stream.Recv(); err != io.EOF {
		t.Errorf("Recv after end = %v, want io.EOF", err)
	}

	if len(chunks) == 0 {
		t.Fatal("no chunks received")
	}
	first := chunks[0]
	if first.ID != "run_1" || first.Object != "chat.completion.chunk" || first.Model != "command-r-plus" {
		t.Errorf("first chunk envelope = %q/%q/%q", first.ID, first.Object, first.Model)
	}
	if first.Choices[0].Delta.Role != "assistant" {
		t.Errorf("first delta role = %q, want assistant", first.Choices[0].Delta.Role)
	}
	// Cohere's wire indices are content-block positions (1, 2 here); OpenAI
	// tool indices must instead count tool-call-starts from 0.
	if want := []int{0, 0, 0, 1, 1}; !reflect.DeepEqual(toolIndices, want) {
		t.Errorf("tool indices = %v, want %v", toolIndices, want)
	}

	final := acc.Response()
	if len(final.Choices) != 1 {
		t.Fatalf("accumulated choices = %d, want 1", len(final.Choices))
	}
	msg := final.Choices[0].Message
	if got := msg.Content.AsText(); got != "Hello, world" {
		t.Errorf("accumulated content = %q", got)
	}
	if msg.ReasoningContent != "I'll check two things." {
		t.Errorf("accumulated tool_plan = %q", msg.ReasoningContent)
	}
	if len(msg.ToolCalls) != 2 {
		t.Fatalf("accumulated tool calls = %d, want 2", len(msg.ToolCalls))
	}
	if tc := msg.ToolCalls[0]; tc.ID != "call_a" || tc.Function.Name != "get_weather" ||
		tc.Function.Arguments != `{"city":"Paris"}` {
		t.Errorf("tool call 0 = %+v", tc)
	}
	if tc := msg.ToolCalls[1]; tc.ID != "call_b" || tc.Function.Name != "get_time" ||
		tc.Function.Arguments != "{}" {
		t.Errorf("tool call 1 = %+v", tc)
	}
	if final.Choices[0].FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q, want tool_calls", final.Choices[0].FinishReason)
	}
	want := &api.Usage{PromptTokens: 12, CompletionTokens: 25, TotalTokens: 37}
	if !reflect.DeepEqual(final.Usage, want) {
		t.Errorf("usage = %+v, want %+v", final.Usage, want)
	}
}

func TestErrorMapping(t *testing.T) {
	req := func() *api.ChatRequest {
		return &api.ChatRequest{Model: "command-r-plus", Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}}}
	}

	t.Run("rate limit with retry-after", func(t *testing.T) {
		p := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, `{"message":"rate limited, try later"}`)
		})
		_, err := p.Complete(context.Background(), req())
		apiErr, ok := api.AsError(err)
		if !ok {
			t.Fatalf("error = %v, want *api.Error", err)
		}
		if apiErr.Type != api.ErrRateLimit || apiErr.StatusCode != 429 {
			t.Errorf("type/status = %v/%d", apiErr.Type, apiErr.StatusCode)
		}
		if apiErr.Provider != "cohere" || apiErr.Model != "command-r-plus" {
			t.Errorf("attribution = %q/%q", apiErr.Provider, apiErr.Model)
		}
		if apiErr.Message != "rate limited, try later" {
			t.Errorf("message = %q", apiErr.Message)
		}
		if apiErr.RetryAfter != 2*time.Second {
			t.Errorf("retry-after = %v, want 2s", apiErr.RetryAfter)
		}
	})

	t.Run("bad request", func(t *testing.T) {
		p := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"message":"invalid request: temperature"}`)
		})
		_, err := p.Complete(context.Background(), req())
		apiErr, ok := api.AsError(err)
		if !ok || apiErr.Type != api.ErrBadRequest {
			t.Fatalf("error = %v, want invalid_request_error", err)
		}
	})

	t.Run("stream auth error", func(t *testing.T) {
		p := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"message":"invalid api token"}`)
		})
		_, err := p.Stream(context.Background(), req())
		apiErr, ok := api.AsError(err)
		if !ok || apiErr.Type != api.ErrAuthentication {
			t.Fatalf("error = %v, want authentication_error", err)
		}
	})
}

func TestEmbed(t *testing.T) {
	var (
		gotPath string
		gotBody map[string]any
	)
	p := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &gotBody); err != nil {
			t.Errorf("request body not JSON: %v", err)
		}
		io.WriteString(w, `{
			"id": "emb_1",
			"embeddings": {"float": [[0.1, 0.2], [0.3, 0.4]]},
			"meta": {"billed_units": {"input_tokens": 6}}
		}`)
	})

	resp, err := p.Embed(context.Background(), &api.EmbeddingRequest{
		Model: "embed-english-v3.0",
		Input: api.StringOrSlice{"first", "second"},
	})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}

	if gotPath != "/v2/embed" {
		t.Errorf("path = %q, want /v2/embed", gotPath)
	}
	if gotBody["model"] != "embed-english-v3.0" {
		t.Errorf("model = %v", gotBody["model"])
	}
	if !reflect.DeepEqual(gotBody["texts"], []any{"first", "second"}) {
		t.Errorf("texts = %v", gotBody["texts"])
	}
	if gotBody["input_type"] != "search_document" {
		t.Errorf("input_type = %v", gotBody["input_type"])
	}
	if !reflect.DeepEqual(gotBody["embedding_types"], []any{"float"}) {
		t.Errorf("embedding_types = %v", gotBody["embedding_types"])
	}

	if resp.Object != "list" || resp.Model != "embed-english-v3.0" {
		t.Errorf("envelope = %q/%q", resp.Object, resp.Model)
	}
	if len(resp.Data) != 2 {
		t.Fatalf("data len = %d, want 2", len(resp.Data))
	}
	if resp.Data[0].Index != 0 || !reflect.DeepEqual(resp.Data[0].Embedding, api.EmbeddingVector{0.1, 0.2}) {
		t.Errorf("data[0] = %+v", resp.Data[0])
	}
	if resp.Data[1].Index != 1 || !reflect.DeepEqual(resp.Data[1].Embedding, api.EmbeddingVector{0.3, 0.4}) {
		t.Errorf("data[1] = %+v", resp.Data[1])
	}
	want := &api.Usage{PromptTokens: 6, TotalTokens: 6}
	if !reflect.DeepEqual(resp.Usage, want) {
		t.Errorf("usage = %+v, want %+v", resp.Usage, want)
	}
}

func TestKeyResolution(t *testing.T) {
	newEnvProvider := func(t *testing.T, gotAuth *string) api.Provider {
		t.Helper()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*gotAuth = r.Header.Get("Authorization")
			io.WriteString(w, minimalChatResponse)
		}))
		t.Cleanup(srv.Close)
		p, err := api.NewProvider("cohere", api.ProviderConfig{BaseURL: srv.URL})
		if err != nil {
			t.Fatalf("NewProvider: %v", err)
		}
		return p
	}
	req := func() *api.ChatRequest {
		return &api.ChatRequest{Model: "command-r-plus", Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}}}
	}

	t.Run("COHERE_API_KEY preferred", func(t *testing.T) {
		t.Setenv("COHERE_API_KEY", "primary-key")
		t.Setenv("CO_API_KEY", "fallback-key")
		var gotAuth string
		if _, err := newEnvProvider(t, &gotAuth).Complete(context.Background(), req()); err != nil {
			t.Fatalf("Complete: %v", err)
		}
		if gotAuth != "Bearer primary-key" {
			t.Errorf("Authorization = %q, want Bearer primary-key", gotAuth)
		}
	})

	t.Run("CO_API_KEY fallback", func(t *testing.T) {
		t.Setenv("COHERE_API_KEY", "")
		t.Setenv("CO_API_KEY", "fallback-key")
		var gotAuth string
		if _, err := newEnvProvider(t, &gotAuth).Complete(context.Background(), req()); err != nil {
			t.Fatalf("Complete: %v", err)
		}
		if gotAuth != "Bearer fallback-key" {
			t.Errorf("Authorization = %q, want Bearer fallback-key", gotAuth)
		}
	})

	t.Run("missing key errors before any call", func(t *testing.T) {
		t.Setenv("COHERE_API_KEY", "")
		t.Setenv("CO_API_KEY", "")
		p, err := api.NewProvider("cohere", api.ProviderConfig{})
		if err != nil {
			t.Fatalf("NewProvider: %v", err)
		}
		_, err = p.Complete(context.Background(), req())
		apiErr, ok := api.AsError(err)
		if !ok || apiErr.Type != api.ErrAuthentication {
			t.Fatalf("error = %v, want authentication_error", err)
		}
	})
}
