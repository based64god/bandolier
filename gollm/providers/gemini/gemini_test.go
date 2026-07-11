package gemini

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

func f64(v float64) *float64 { return &v }
func iptr(v int) *int        { return &v }

func newProvider(t *testing.T, baseURL string) api.Provider {
	t.Helper()
	p, err := api.NewProvider("gemini", api.ProviderConfig{BaseURL: baseURL, APIKey: "test-key"})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	return p
}

// dig walks a decoded JSON tree by map key (string) or array index (int).
func dig(t *testing.T, v any, path ...any) any {
	t.Helper()
	for _, step := range path {
		switch k := step.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				t.Fatalf("dig %v: not an object at %q (got %T)", path, k, v)
			}
			v, ok = m[k]
			if !ok {
				t.Fatalf("dig %v: missing key %q", path, k)
			}
		case int:
			s, ok := v.([]any)
			if !ok || k >= len(s) {
				t.Fatalf("dig %v: not an array of len > %d (got %T)", path, k, v)
			}
			v = s[k]
		}
	}
	return v
}

const minimalResponse = `{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}`

func TestAliasRegistered(t *testing.T) {
	name, ok := api.Resolve("google")
	if !ok || name != "gemini" {
		t.Fatalf("Resolve(google) = %q, %v; want gemini, true", name, ok)
	}
}

func TestCompleteRequestTranslation(t *testing.T) {
	var gotPath, gotKey string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-goog-api-key")
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &gotBody); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		io.WriteString(w, minimalResponse)
	}))
	defer srv.Close()

	schema := json.RawMessage(`{
		"$schema": "http://json-schema.org/draft-07/schema#",
		"type": "object",
		"additionalProperties": false,
		"properties": {
			"city": {"type": "string"},
			"opts": {"type": "object", "additionalProperties": false, "$id": "x"}
		}
	}`)
	req := &api.ChatRequest{
		Model: "gemini-2.0-flash",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be brief")},
			{Role: "user", Content: api.PartsContent(
				api.TextPart("what is this?"),
				api.ImagePart("data:image/png;base64,aGk="),
				api.ImagePart("https://example.com/cat.png"),
			)},
			{Role: "assistant", Content: api.TextContent("let me check"), ToolCalls: []api.ToolCall{{
				ID: "call_abc", Type: "function",
				Function: api.ToolCallFunction{Name: "get_weather", Arguments: `{"city":"Paris"}`},
			}}},
			{Role: "tool", ToolCallID: "call_abc", Content: api.TextContent("sunny")},
			{Role: "user", Content: api.TextContent("thanks")},
		},
		Temperature:     f64(0.4),
		TopP:            f64(0.9),
		N:               iptr(2),
		Stop:            api.StringOrSlice{"END"},
		MaxTokens:       iptr(512),
		ReasoningEffort: "medium",
		ResponseFormat:  &api.ResponseFormat{Type: "json_schema", JSONSchema: &api.JSONSchemaSpec{Name: "out", Schema: schema}},
		Tools: []api.Tool{{Type: "function", Function: api.ToolFunction{
			Name: "get_weather", Description: "look up weather", Parameters: schema,
		}}},
		ToolChoice: api.ToolChoiceFunction("get_weather"),
		Extra:      map[string]any{"top_k": 40},
	}

	if _, err := newProvider(t, srv.URL).Complete(context.Background(), req); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if gotPath != "/models/gemini-2.0-flash:generateContent" {
		t.Errorf("path = %q", gotPath)
	}
	if gotKey != "test-key" {
		t.Errorf("x-goog-api-key = %q", gotKey)
	}

	// System messages hoist to systemInstruction.
	if got := dig(t, gotBody, "systemInstruction", "parts", 0, "text"); got != "be brief" {
		t.Errorf("systemInstruction text = %v", got)
	}

	// contents[0]: user turn with text + inline image + file reference.
	if got := dig(t, gotBody, "contents", 0, "role"); got != "user" {
		t.Errorf("contents[0].role = %v", got)
	}
	if got := dig(t, gotBody, "contents", 0, "parts", 0, "text"); got != "what is this?" {
		t.Errorf("contents[0].parts[0].text = %v", got)
	}
	if got := dig(t, gotBody, "contents", 0, "parts", 1, "inlineData", "mimeType"); got != "image/png" {
		t.Errorf("inlineData.mimeType = %v", got)
	}
	if got := dig(t, gotBody, "contents", 0, "parts", 1, "inlineData", "data"); got != "aGk=" {
		t.Errorf("inlineData.data = %v", got)
	}
	if got := dig(t, gotBody, "contents", 0, "parts", 2, "fileData", "fileUri"); got != "https://example.com/cat.png" {
		t.Errorf("fileData.fileUri = %v", got)
	}

	// contents[1]: assistant → model, tool call args decoded to an object.
	if got := dig(t, gotBody, "contents", 1, "role"); got != "model" {
		t.Errorf("contents[1].role = %v", got)
	}
	if got := dig(t, gotBody, "contents", 1, "parts", 0, "text"); got != "let me check" {
		t.Errorf("contents[1].parts[0].text = %v", got)
	}
	if got := dig(t, gotBody, "contents", 1, "parts", 1, "functionCall", "name"); got != "get_weather" {
		t.Errorf("functionCall.name = %v", got)
	}
	if got := dig(t, gotBody, "contents", 1, "parts", 1, "functionCall", "args", "city"); got != "Paris" {
		t.Errorf("functionCall.args.city = %v", got)
	}

	// contents[2]: tool response resolves the function name via the id→name
	// map, and the trailing user text merges into the same user turn.
	if got := dig(t, gotBody, "contents", 2, "role"); got != "user" {
		t.Errorf("contents[2].role = %v", got)
	}
	if got := dig(t, gotBody, "contents", 2, "parts", 0, "functionResponse", "name"); got != "get_weather" {
		t.Errorf("functionResponse.name = %v", got)
	}
	if got := dig(t, gotBody, "contents", 2, "parts", 0, "functionResponse", "response", "content"); got != "sunny" {
		t.Errorf("functionResponse.response.content = %v", got)
	}
	if got := dig(t, gotBody, "contents", 2, "parts", 1, "text"); got != "thanks" {
		t.Errorf("merged user text = %v", got)
	}
	if all := dig(t, gotBody, "contents").([]any); len(all) != 3 {
		t.Errorf("len(contents) = %d, want 3", len(all))
	}

	// Tool schema sanitized at every level.
	params := dig(t, gotBody, "tools", 0, "functionDeclarations", 0, "parameters").(map[string]any)
	if _, ok := params["$schema"]; ok {
		t.Error("parameters kept $schema")
	}
	if _, ok := params["additionalProperties"]; ok {
		t.Error("parameters kept additionalProperties")
	}
	nested := dig(t, params, "properties", "opts").(map[string]any)
	if _, ok := nested["additionalProperties"]; ok {
		t.Error("nested schema kept additionalProperties")
	}
	if _, ok := nested["$id"]; ok {
		t.Error("nested schema kept $id")
	}

	if got := dig(t, gotBody, "toolConfig", "functionCallingConfig", "mode"); got != "ANY" {
		t.Errorf("toolConfig mode = %v", got)
	}
	if got := dig(t, gotBody, "toolConfig", "functionCallingConfig", "allowedFunctionNames", 0); got != "get_weather" {
		t.Errorf("allowedFunctionNames = %v", got)
	}

	if got := dig(t, gotBody, "generationConfig", "temperature"); got != 0.4 {
		t.Errorf("temperature = %v", got)
	}
	if got := dig(t, gotBody, "generationConfig", "topP"); got != 0.9 {
		t.Errorf("topP = %v", got)
	}
	if got := dig(t, gotBody, "generationConfig", "topK"); got != float64(40) {
		t.Errorf("topK = %v", got)
	}
	if got := dig(t, gotBody, "generationConfig", "maxOutputTokens"); got != float64(512) {
		t.Errorf("maxOutputTokens = %v", got)
	}
	if got := dig(t, gotBody, "generationConfig", "stopSequences", 0); got != "END" {
		t.Errorf("stopSequences = %v", got)
	}
	if got := dig(t, gotBody, "generationConfig", "candidateCount"); got != float64(2) {
		t.Errorf("candidateCount = %v", got)
	}
	if got := dig(t, gotBody, "generationConfig", "responseMimeType"); got != "application/json" {
		t.Errorf("responseMimeType = %v", got)
	}
	rs := dig(t, gotBody, "generationConfig", "responseSchema").(map[string]any)
	if _, ok := rs["$schema"]; ok {
		t.Error("responseSchema kept $schema")
	}
	if got := dig(t, gotBody, "generationConfig", "thinkingConfig", "thinkingBudget"); got != float64(8192) {
		t.Errorf("thinkingBudget = %v", got)
	}
	if got := dig(t, gotBody, "generationConfig", "thinkingConfig", "includeThoughts"); got != true {
		t.Errorf("includeThoughts = %v", got)
	}
}

func TestToolChoiceModes(t *testing.T) {
	for choice, wantMode := range map[*api.ToolChoice]string{
		api.ToolChoiceAuto():     "AUTO",
		api.ToolChoiceNone():     "NONE",
		api.ToolChoiceRequired(): "ANY",
	} {
		var gotBody map[string]any
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewDecoder(r.Body).Decode(&gotBody)
			io.WriteString(w, minimalResponse)
		}))
		req := &api.ChatRequest{
			Model:      "gemini-2.0-flash",
			Messages:   []api.Message{{Role: "user", Content: api.TextContent("hi")}},
			ToolChoice: choice,
		}
		if _, err := newProvider(t, srv.URL).Complete(context.Background(), req); err != nil {
			t.Fatalf("Complete(%s): %v", choice.Mode, err)
		}
		if got := dig(t, gotBody, "toolConfig", "functionCallingConfig", "mode"); got != wantMode {
			t.Errorf("mode for %q = %v, want %v", choice.Mode, got, wantMode)
		}
		srv.Close()
	}
}

func TestCompleteResponseTranslation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{
			"candidates": [{
				"content": {"parts": [
					{"text": "pondering...", "thought": true},
					{"text": "The answer is 4."},
					{"functionCall": {"name": "lookup", "args": {"q": "2+2"}}}
				], "role": "model"},
				"finishReason": "STOP",
				"index": 0
			}],
			"usageMetadata": {
				"promptTokenCount": 12,
				"candidatesTokenCount": 8,
				"totalTokenCount": 30,
				"cachedContentTokenCount": 4,
				"thoughtsTokenCount": 10
			},
			"modelVersion": "gemini-2.0-flash-001",
			"responseId": "resp-123"
		}`)
	}))
	defer srv.Close()

	resp, err := newProvider(t, srv.URL).Complete(context.Background(), &api.ChatRequest{
		Model:    "gemini-2.0-flash",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("2+2?")}},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if resp.ID != "resp-123" {
		t.Errorf("ID = %q", resp.ID)
	}
	if resp.Model != "gemini-2.0-flash-001" {
		t.Errorf("Model = %q", resp.Model)
	}
	if resp.Provider != "gemini" {
		t.Errorf("Provider = %q", resp.Provider)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("len(Choices) = %d", len(resp.Choices))
	}
	choice := resp.Choices[0]
	if choice.Message.Content.AsText() != "The answer is 4." {
		t.Errorf("content = %q", choice.Message.Content.AsText())
	}
	if choice.Message.ReasoningContent != "pondering..." {
		t.Errorf("reasoning = %q", choice.Message.ReasoningContent)
	}
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("len(ToolCalls) = %d", len(choice.Message.ToolCalls))
	}
	tc := choice.Message.ToolCalls[0]
	if tc.ID != "call_1" || tc.Type != "function" || tc.Function.Name != "lookup" {
		t.Errorf("tool call = %+v", tc)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil || args["q"] != "2+2" {
		t.Errorf("arguments = %q (err %v)", tc.Function.Arguments, err)
	}
	// functionCall present → tool_calls even though Gemini said STOP.
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish = %q", choice.FinishReason)
	}

	u := resp.Usage
	if u == nil {
		t.Fatal("Usage = nil")
	}
	// prompt(12)+candidates(8) != total(30) → thoughts counted separately.
	if u.PromptTokens != 12 || u.CompletionTokens != 18 || u.TotalTokens != 30 {
		t.Errorf("usage = %+v", u)
	}
	if u.PromptTokensDetails == nil || u.PromptTokensDetails.CachedTokens != 4 {
		t.Errorf("prompt details = %+v", u.PromptTokensDetails)
	}
	if u.CompletionTokensDetails == nil || u.CompletionTokensDetails.ReasoningTokens != 10 {
		t.Errorf("completion details = %+v", u.CompletionTokensDetails)
	}
}

func TestFinishReasonMapping(t *testing.T) {
	for gemini, want := range map[string]string{
		"MAX_TOKENS":         "length",
		"SAFETY":             "content_filter",
		"RECITATION":         "content_filter",
		"BLOCKLIST":          "content_filter",
		"PROHIBITED_CONTENT": "content_filter",
		"SPII":               "content_filter",
		"STOP":               "stop",
		"OTHER":              "stop",
	} {
		if got := mapFinishReason(gemini, false); got != want {
			t.Errorf("mapFinishReason(%q) = %q, want %q", gemini, got, want)
		}
	}
	if got := mapFinishReason("SAFETY", true); got != "tool_calls" {
		t.Errorf("tool call should win: got %q", got)
	}
}

func TestStream(t *testing.T) {
	var gotPath, gotAlt string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAlt = r.URL.Query().Get("alt")
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, strings.Join([]string{
			`data: {"candidates":[{"content":{"parts":[{"text":"mull","thought":true}],"role":"model"},"index":0}],"responseId":"resp-s1"}`,
			``,
			`data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}]}`,
			``,
			`data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"index":0}]}`,
			``,
			`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}`,
			``,
			``,
		}, "\n"))
	}))
	defer srv.Close()

	stream, err := newProvider(t, srv.URL).Stream(context.Background(), &api.ChatRequest{
		Model:    "gemini-2.0-flash",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	var chunks []*api.ChatChunk
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		acc.Add(chunk)
		chunks = append(chunks, chunk)
	}

	if gotPath != "/models/gemini-2.0-flash:streamGenerateContent" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAlt != "sse" {
		t.Errorf("alt = %q", gotAlt)
	}
	if len(chunks) != 4 {
		t.Fatalf("len(chunks) = %d, want 4", len(chunks))
	}
	if chunks[0].Choices[0].Delta.Role != "assistant" {
		t.Errorf("first chunk role = %q", chunks[0].Choices[0].Delta.Role)
	}
	if chunks[1].Choices[0].Delta.Role != "" {
		t.Error("role re-sent on second chunk")
	}
	if chunks[0].ID != "resp-s1" || chunks[1].ID != "resp-s1" {
		t.Errorf("chunk ids = %q, %q", chunks[0].ID, chunks[1].ID)
	}
	if chunks[0].Choices[0].Delta.ReasoningContent != "mull" {
		t.Errorf("reasoning delta = %q", chunks[0].Choices[0].Delta.ReasoningContent)
	}
	last := chunks[3].Choices[0]
	if last.Delta.ToolCalls == nil || last.Delta.ToolCalls[0].Index == nil || *last.Delta.ToolCalls[0].Index != 0 {
		t.Errorf("tool call delta = %+v", last.Delta.ToolCalls)
	}
	if last.FinishReason != "tool_calls" {
		t.Errorf("stream finish = %q", last.FinishReason)
	}

	final := acc.Response()
	msg := final.Choices[0].Message
	if msg.Content.AsText() != "Hello world" {
		t.Errorf("accumulated content = %q", msg.Content.AsText())
	}
	if msg.ReasoningContent != "mull" {
		t.Errorf("accumulated reasoning = %q", msg.ReasoningContent)
	}
	if len(msg.ToolCalls) != 1 || msg.ToolCalls[0].Function.Name != "get_weather" ||
		msg.ToolCalls[0].Function.Arguments != `{"city":"Paris"}` || msg.ToolCalls[0].ID != "call_1" {
		t.Errorf("accumulated tool calls = %+v", msg.ToolCalls)
	}
	if final.Usage == nil || final.Usage.PromptTokens != 10 || final.Usage.CompletionTokens != 5 || final.Usage.TotalTokens != 15 {
		t.Errorf("accumulated usage = %+v", final.Usage)
	}
}

func TestBlockedPrompt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"promptFeedback":{"blockReason":"SAFETY"}}`)
	}))
	defer srv.Close()

	req := func() *api.ChatRequest {
		return &api.ChatRequest{
			Model:    "gemini-2.0-flash",
			Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		}
	}
	resp, err := newProvider(t, srv.URL).Complete(context.Background(), req())
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if len(resp.Choices) != 1 || resp.Choices[0].FinishReason != "content_filter" {
		t.Errorf("choices = %+v", resp.Choices)
	}
	if !resp.Choices[0].Message.Content.IsZero() {
		t.Errorf("blocked prompt content = %+v", resp.Choices[0].Message.Content)
	}

	// Same blockReason arriving as a stream event.
	sseSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n\n")
	}))
	defer sseSrv.Close()

	stream, err := newProvider(t, sseSrv.URL).Stream(context.Background(), req())
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()
	chunk, err := stream.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	if len(chunk.Choices) != 1 || chunk.Choices[0].FinishReason != "content_filter" {
		t.Errorf("stream chunk = %+v", chunk)
	}
	if _, err := stream.Recv(); err != io.EOF {
		t.Errorf("want EOF after blocked chunk, got %v", err)
	}
}

func TestMalformedToolArgsWrapped(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&gotBody)
		io.WriteString(w, minimalResponse)
	}))
	defer srv.Close()

	req := &api.ChatRequest{
		Model: "gemini-2.0-flash",
		Messages: []api.Message{
			{Role: "user", Content: api.TextContent("hi")},
			{Role: "assistant", ToolCalls: []api.ToolCall{{
				ID: "call_1", Type: "function",
				Function: api.ToolCallFunction{Name: "lookup", Arguments: `{"q": trunc`},
			}}},
		},
	}
	if _, err := newProvider(t, srv.URL).Complete(context.Background(), req); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got := dig(t, gotBody, "contents", 1, "parts", 0, "functionCall", "args", "_raw_arguments"); got != `{"q": trunc` {
		t.Errorf("_raw_arguments = %v", got)
	}
}

func TestStreamMidStreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"a\"}],\"role\":\"model\"}}]}\n\n"+
			"data: {\"error\":{\"code\":503,\"message\":\"The model is overloaded.\",\"status\":\"UNAVAILABLE\"}}\n\n")
	}))
	defer srv.Close()

	stream, err := newProvider(t, srv.URL).Stream(context.Background(), &api.ChatRequest{
		Model:    "gemini-2.0-flash",
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
	if !ok {
		t.Fatalf("want *api.Error, got %v", err)
	}
	if apiErr.Type != api.ErrUnavailable || apiErr.StatusCode != 503 {
		t.Errorf("error = %+v", apiErr)
	}
}

func TestErrorMapping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}`)
	}))
	defer srv.Close()

	_, err := newProvider(t, srv.URL).Complete(context.Background(), &api.ChatRequest{
		Model:    "gemini-2.0-flash",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("want *api.Error, got %v", err)
	}
	if apiErr.Type != api.ErrRateLimit {
		t.Errorf("Type = %q", apiErr.Type)
	}
	if apiErr.StatusCode != 429 {
		t.Errorf("StatusCode = %d", apiErr.StatusCode)
	}
	if apiErr.Provider != "gemini" || apiErr.Model != "gemini-2.0-flash" {
		t.Errorf("attribution = %q/%q", apiErr.Provider, apiErr.Model)
	}
	if apiErr.RetryAfter != 30*time.Second {
		t.Errorf("RetryAfter = %v", apiErr.RetryAfter)
	}
	if !strings.Contains(apiErr.Message, "Resource has been exhausted") {
		t.Errorf("Message = %q", apiErr.Message)
	}
	if !apiErr.Retryable() {
		t.Error("429 should be retryable")
	}
}

func TestEmbedSingle(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewDecoder(r.Body).Decode(&gotBody)
		io.WriteString(w, `{"embedding":{"values":[0.1,0.2,0.3]},"usageMetadata":{"promptTokenCount":5,"totalTokenCount":5}}`)
	}))
	defer srv.Close()

	resp, err := newProvider(t, srv.URL).Embed(context.Background(), &api.EmbeddingRequest{
		Model:      "text-embedding-004",
		Input:      api.StringOrSlice{"hello"},
		Dimensions: iptr(256),
	})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}

	if gotPath != "/models/text-embedding-004:embedContent" {
		t.Errorf("path = %q", gotPath)
	}
	if got := dig(t, gotBody, "content", "parts", 0, "text"); got != "hello" {
		t.Errorf("content text = %v", got)
	}
	if got := dig(t, gotBody, "outputDimensionality"); got != float64(256) {
		t.Errorf("outputDimensionality = %v", got)
	}
	if resp.Object != "list" || len(resp.Data) != 1 {
		t.Fatalf("resp = %+v", resp)
	}
	if resp.Data[0].Index != 0 || resp.Data[0].Object != "embedding" ||
		len(resp.Data[0].Embedding) != 3 || resp.Data[0].Embedding[1] != 0.2 {
		t.Errorf("embedding = %+v", resp.Data[0])
	}
	if resp.Usage == nil || resp.Usage.PromptTokens != 5 || resp.Usage.TotalTokens != 5 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestEmbedBatch(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewDecoder(r.Body).Decode(&gotBody)
		io.WriteString(w, `{"embeddings":[{"values":[1,2]},{"values":[3,4]}]}`)
	}))
	defer srv.Close()

	resp, err := newProvider(t, srv.URL).Embed(context.Background(), &api.EmbeddingRequest{
		Model: "text-embedding-004",
		Input: api.StringOrSlice{"one", "two"},
	})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}

	if gotPath != "/models/text-embedding-004:batchEmbedContents" {
		t.Errorf("path = %q", gotPath)
	}
	if got := dig(t, gotBody, "requests", 0, "model"); got != "models/text-embedding-004" {
		t.Errorf("requests[0].model = %v", got)
	}
	if got := dig(t, gotBody, "requests", 1, "content", "parts", 0, "text"); got != "two" {
		t.Errorf("requests[1] text = %v", got)
	}
	if len(resp.Data) != 2 {
		t.Fatalf("len(Data) = %d", len(resp.Data))
	}
	if resp.Data[1].Index != 1 || resp.Data[1].Embedding[0] != 3 {
		t.Errorf("Data[1] = %+v", resp.Data[1])
	}
}

func TestEnvKeyFallback(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-goog-api-key")
		io.WriteString(w, minimalResponse)
	}))
	defer srv.Close()

	req := func() *api.ChatRequest {
		return &api.ChatRequest{
			Model:    "gemini-2.0-flash",
			Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		}
	}
	p, err := api.NewProvider("gemini", api.ProviderConfig{BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}

	// GEMINI_API_KEY wins over GOOGLE_API_KEY.
	t.Setenv("GEMINI_API_KEY", "gemini-env-key")
	t.Setenv("GOOGLE_API_KEY", "google-env-key")
	if _, err := p.Complete(context.Background(), req()); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if gotKey != "gemini-env-key" {
		t.Errorf("key = %q, want gemini-env-key", gotKey)
	}

	t.Setenv("GEMINI_API_KEY", "")
	if _, err := p.Complete(context.Background(), req()); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if gotKey != "google-env-key" {
		t.Errorf("key = %q, want google-env-key", gotKey)
	}

	t.Setenv("GOOGLE_API_KEY", "")
	_, err = p.Complete(context.Background(), req())
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("want authentication error, got %v", err)
	}
}
