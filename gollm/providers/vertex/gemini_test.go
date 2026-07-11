package vertex

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

// captured records what the fake API server received.
type captured struct {
	path  string
	query string
	auth  string
	body  map[string]any
}

// captureHandler records the request and serves a canned body.
func captureHandler(t *testing.T, out *captured, contentType, respBody string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		out.path = r.URL.Path
		out.query = r.URL.RawQuery
		out.auth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &out.body); err != nil {
				t.Errorf("request body is not JSON: %v", err)
			}
		}
		w.Header().Set("Content-Type", contentType)
		io.WriteString(w, respBody)
	}
}

// at walks a decoded JSON tree by map keys and array indices.
func at(t *testing.T, v any, path ...any) any {
	t.Helper()
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				t.Fatalf("expected object at %v, got %T", p, v)
			}
			v = m[k]
		case int:
			a, ok := v.([]any)
			if !ok || k >= len(a) {
				t.Fatalf("expected array reaching index %d, got %T", k, v)
			}
			v = a[k]
		}
	}
	return v
}

// staticKeyProvider builds a vertex provider that talks to the fake server
// with a pre-minted access token (no OAuth dance).
func staticKeyProvider(t *testing.T, apiEndpoint string) api.Provider {
	t.Helper()
	p, err := api.NewProvider("vertex", api.ProviderConfig{
		APIKey: "test-key",
		Extra: map[string]string{
			"project":      "proj-1",
			"location":     "us-east5",
			"api_endpoint": apiEndpoint,
		},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	return p
}

func TestGeminiCompleteTranslation(t *testing.T) {
	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "application/json", `{
		"responseId": "resp-1",
		"modelVersion": "gemini-2.0-flash-001",
		"candidates": [{
			"index": 0,
			"content": {"role": "model", "parts": [
				{"text": "considering...", "thought": true},
				{"text": "It is "},
				{"text": "sunny."},
				{"functionCall": {"name": "get_weather", "args": {"city": "Paris"}}}
			]},
			"finishReason": "STOP"
		}],
		"usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 18,
			"thoughtsTokenCount": 3, "cachedContentTokenCount": 4}
	}`))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	temp, maxTok := 0.5, 512
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:       "gemini-2.0-flash",
		Temperature: &temp,
		MaxTokens:   &maxTok,
		Stop:        api.StringOrSlice{"END"},
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be terse")},
			{Role: "user", Content: api.PartsContent(
				api.TextPart("what's the weather in paris?"),
				api.ImagePart("data:image/png;base64,aGk="),
			)},
			{Role: "assistant", ToolCalls: []api.ToolCall{{
				ID:       "call_1",
				Type:     "function",
				Function: api.ToolCallFunction{Name: "get_weather", Arguments: `{"city":"Paris"}`},
			}}},
			{Role: "tool", ToolCallID: "call_1", Content: api.TextContent("sunny, 21C")},
		},
		Tools: []api.Tool{{Type: "function", Function: api.ToolFunction{
			Name:        "get_weather",
			Description: "look up weather",
			Parameters: json.RawMessage(`{"$schema":"http://json-schema.org/draft-07/schema#",` +
				`"type":"object","additionalProperties":false,"strict":true,` +
				`"properties":{"city":{"type":"string"}}}`),
		}}},
		ToolChoice: api.ToolChoiceFunction("get_weather"),
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	// ── outbound translation ──
	wantPath := "/v1/projects/proj-1/locations/us-east5/publishers/google/models/gemini-2.0-flash:generateContent"
	if c.path != wantPath {
		t.Errorf("path = %s, want %s", c.path, wantPath)
	}
	if c.auth != "Bearer test-key" {
		t.Errorf("Authorization = %q", c.auth)
	}
	if got := at(t, c.body, "systemInstruction", "parts", 0, "text"); got != "be terse" {
		t.Errorf("systemInstruction = %v", got)
	}
	if got := at(t, c.body, "contents", 0, "role"); got != "user" {
		t.Errorf("contents[0].role = %v", got)
	}
	if got := at(t, c.body, "contents", 0, "parts", 1, "inlineData", "mimeType"); got != "image/png" {
		t.Errorf("inlineData.mimeType = %v", got)
	}
	if got := at(t, c.body, "contents", 0, "parts", 1, "inlineData", "data"); got != "aGk=" {
		t.Errorf("inlineData.data = %v", got)
	}
	if got := at(t, c.body, "contents", 1, "role"); got != "model" {
		t.Errorf("contents[1].role = %v", got)
	}
	if got := at(t, c.body, "contents", 1, "parts", 0, "functionCall", "args", "city"); got != "Paris" {
		t.Errorf("functionCall.args.city = %v", got)
	}
	// The tool result references the function by name, recovered from the
	// tool-call id in history.
	if got := at(t, c.body, "contents", 2, "parts", 0, "functionResponse", "name"); got != "get_weather" {
		t.Errorf("functionResponse.name = %v", got)
	}
	if got := at(t, c.body, "contents", 2, "parts", 0, "functionResponse", "response", "content"); got != "sunny, 21C" {
		t.Errorf("functionResponse.response = %v", got)
	}

	params := at(t, c.body, "tools", 0, "functionDeclarations", 0, "parameters").(map[string]any)
	for _, k := range []string{"$schema", "additionalProperties", "strict"} {
		if _, ok := params[k]; ok {
			t.Errorf("schema still contains %s", k)
		}
	}
	if got := at(t, params, "properties", "city", "type"); got != "string" {
		t.Errorf("schema properties lost: %v", got)
	}
	if got := at(t, c.body, "toolConfig", "functionCallingConfig", "mode"); got != "ANY" {
		t.Errorf("toolConfig.mode = %v", got)
	}
	if got := at(t, c.body, "toolConfig", "functionCallingConfig", "allowedFunctionNames", 0); got != "get_weather" {
		t.Errorf("allowedFunctionNames = %v", got)
	}
	if got := at(t, c.body, "generationConfig", "temperature"); got != 0.5 {
		t.Errorf("temperature = %v", got)
	}
	if got := at(t, c.body, "generationConfig", "maxOutputTokens"); got != float64(512) {
		t.Errorf("maxOutputTokens = %v", got)
	}
	if got := at(t, c.body, "generationConfig", "stopSequences", 0); got != "END" {
		t.Errorf("stopSequences = %v", got)
	}

	// ── response translation ──
	if resp.ID != "resp-1" || resp.Model != "gemini-2.0-flash-001" || resp.Provider != "vertex" {
		t.Errorf("id/model/provider = %s/%s/%s", resp.ID, resp.Model, resp.Provider)
	}
	choice := resp.Choices[0]
	if got := choice.Message.Content.AsText(); got != "It is sunny." {
		t.Errorf("content = %q", got)
	}
	if choice.Message.ReasoningContent != "considering..." {
		t.Errorf("reasoning = %q", choice.Message.ReasoningContent)
	}
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(choice.Message.ToolCalls))
	}
	tc := choice.Message.ToolCalls[0]
	if tc.Function.Name != "get_weather" || !strings.Contains(tc.Function.Arguments, "Paris") {
		t.Errorf("tool call = %+v", tc)
	}
	if !strings.HasPrefix(tc.ID, "call_") {
		t.Errorf("tool call id %q should be synthesized with call_ prefix", tc.ID)
	}
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish = %q, want tool_calls", choice.FinishReason)
	}
	u := resp.Usage
	if u.PromptTokens != 10 || u.CompletionTokens != 8 || u.TotalTokens != 18 {
		t.Errorf("usage = %+v", u)
	}
	if u.PromptTokensDetails.CachedTokens != 4 || u.CompletionTokensDetails.ReasoningTokens != 3 {
		t.Errorf("usage details = %+v %+v", u.PromptTokensDetails, u.CompletionTokensDetails)
	}
}

func TestGeminiStream(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"responseId":"r-2","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Hel"}]}}]}`,
		"",
		`data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"lo"}]}}]}`,
		"",
		`data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":4,"totalTokenCount":11}}`,
		"",
		"",
	}, "\n")

	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "text/event-stream", sse))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "gemini-2.0-flash",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	var chunks []*api.ChatChunk
	acc := api.NewStreamAccumulator()
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
	}

	if !strings.HasSuffix(c.path, ":streamGenerateContent") {
		t.Errorf("path = %s, want :streamGenerateContent suffix", c.path)
	}
	if c.query != "alt=sse" {
		t.Errorf("query = %q, want alt=sse", c.query)
	}
	if len(chunks) == 0 || chunks[0].Choices[0].Delta.Role != "assistant" {
		t.Error("first chunk should carry the assistant role")
	}

	resp := acc.Response()
	if resp.ID != "r-2" {
		t.Errorf("id = %q", resp.ID)
	}
	choice := resp.Choices[0]
	if got := choice.Message.Content.AsText(); got != "Hello" {
		t.Errorf("content = %q", got)
	}
	if len(choice.Message.ToolCalls) != 1 || choice.Message.ToolCalls[0].Function.Name != "get_weather" {
		t.Fatalf("tool calls = %+v", choice.Message.ToolCalls)
	}
	if !strings.Contains(choice.Message.ToolCalls[0].Function.Arguments, "Paris") {
		t.Errorf("arguments = %q", choice.Message.ToolCalls[0].Function.Arguments)
	}
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish = %q, want tool_calls", choice.FinishReason)
	}
	if resp.Usage == nil || resp.Usage.PromptTokens != 7 || resp.Usage.CompletionTokens != 4 || resp.Usage.TotalTokens != 11 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestGeminiStreamInBandError(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Hel"}]}}]}`,
		"",
		`data: {"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}`,
		"",
		"",
	}, "\n")

	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "text/event-stream", sse))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "gemini-2.0-flash",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	chunk, err := stream.Recv()
	if err != nil {
		t.Fatalf("first Recv: %v", err)
	}
	if got := chunk.Choices[0].Delta.Content; got != "Hel" {
		t.Errorf("first chunk content = %q, want Hel", got)
	}

	_, err = stream.Recv()
	if err == io.EOF {
		t.Fatal("in-band error payload was silently skipped (Recv returned EOF)")
	}
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error is %T (%v), want *api.Error", err, err)
	}
	if apiErr.Type != api.ErrRateLimit || apiErr.StatusCode != 429 {
		t.Errorf("type/status = %s/%d, want %s/429", apiErr.Type, apiErr.StatusCode, api.ErrRateLimit)
	}
	if !strings.Contains(apiErr.Message, "exhausted") {
		t.Errorf("message = %q, want the in-band error message", apiErr.Message)
	}
	if apiErr.Provider != "vertex" || apiErr.Model != "gemini-2.0-flash" {
		t.Errorf("provider/model = %s/%s", apiErr.Provider, apiErr.Model)
	}
}

func TestGeminiErrorMapping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"code":429,"message":"Quota exceeded for model","status":"RESOURCE_EXHAUSTED"}}`)
	}))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "gemini-2.0-flash",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error is %T, want *api.Error", err)
	}
	if apiErr.Type != api.ErrRateLimit || apiErr.StatusCode != 429 {
		t.Errorf("type/status = %s/%d", apiErr.Type, apiErr.StatusCode)
	}
	if apiErr.RetryAfter != 7*time.Second {
		t.Errorf("retryAfter = %v", apiErr.RetryAfter)
	}
	if !strings.Contains(apiErr.Message, "Quota exceeded") {
		t.Errorf("message = %q", apiErr.Message)
	}
	if apiErr.Provider != "vertex" || apiErr.Model != "gemini-2.0-flash" {
		t.Errorf("provider/model = %s/%s", apiErr.Provider, apiErr.Model)
	}
}

func TestEmbed(t *testing.T) {
	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "application/json", `{
		"predictions": [
			{"embeddings": {"values": [0.1, 0.2], "statistics": {"token_count": 4}}},
			{"embeddings": {"values": [0.3], "statistics": {"token_count": 2}}}
		]
	}`))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	dims := 256
	resp, err := p.Embed(context.Background(), &api.EmbeddingRequest{
		Model:      "text-embedding-005",
		Input:      api.StringOrSlice{"first", "second"},
		Dimensions: &dims,
	})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}

	if !strings.HasSuffix(c.path, "/publishers/google/models/text-embedding-005:predict") {
		t.Errorf("path = %s", c.path)
	}
	if got := at(t, c.body, "instances", 0, "content"); got != "first" {
		t.Errorf("instances[0] = %v", got)
	}
	if got := at(t, c.body, "instances", 1, "content"); got != "second" {
		t.Errorf("instances[1] = %v", got)
	}
	if got := at(t, c.body, "parameters", "outputDimensionality"); got != float64(256) {
		t.Errorf("outputDimensionality = %v", got)
	}

	if len(resp.Data) != 2 || len(resp.Data[0].Embedding) != 2 || resp.Data[1].Embedding[0] != 0.3 {
		t.Errorf("data = %+v", resp.Data)
	}
	if resp.Data[1].Index != 1 {
		t.Errorf("index = %d", resp.Data[1].Index)
	}
	if resp.Usage == nil || resp.Usage.PromptTokens != 6 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestEmbedClaudeNotSupported(t *testing.T) {
	p := staticKeyProvider(t, "http://unused.invalid")
	_, err := p.Embed(context.Background(), &api.EmbeddingRequest{
		Model: "claude-sonnet-4@20250514",
		Input: api.StringOrSlice{"x"},
	})
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrNotSupported {
		t.Fatalf("err = %v, want not_supported_error", err)
	}
}
