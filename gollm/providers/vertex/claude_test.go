package vertex

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

func TestClaudeCompleteTranslation(t *testing.T) {
	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "application/json", `{
		"id": "msg_01", "type": "message", "role": "assistant", "model": "claude-sonnet-4",
		"content": [
			{"type": "text", "text": "Hi there"},
			{"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Paris"}}
		],
		"stop_reason": "tool_use",
		"usage": {"input_tokens": 11, "output_tokens": 9, "cache_read_input_tokens": 2}
	}`))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	maxTok := 256
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:     "claude-sonnet-4@20250514",
		MaxTokens: &maxTok,
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be terse")},
			{Role: "user", Content: api.TextContent("hello")},
		},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	// ── outbound translation ──
	wantPath := "/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4@20250514:rawPredict"
	if c.path != wantPath {
		t.Errorf("path = %s, want %s", c.path, wantPath)
	}
	if c.auth != "Bearer test-key" {
		t.Errorf("Authorization = %q", c.auth)
	}
	// Vertex takes the model from the URL: the body must carry
	// anthropic_version instead of a model field.
	if _, ok := c.body["model"]; ok {
		t.Error("body must not contain a model field")
	}
	if got := c.body["anthropic_version"]; got != anthropicVersion {
		t.Errorf("anthropic_version = %v, want %s", got, anthropicVersion)
	}
	if got := c.body["system"]; got != "be terse" {
		t.Errorf("system = %v", got)
	}
	if got := c.body["max_tokens"]; got != float64(256) {
		t.Errorf("max_tokens = %v", got)
	}
	if got := at(t, c.body, "messages", 0, "role"); got != "user" {
		t.Errorf("messages[0].role = %v", got)
	}
	if got := at(t, c.body, "messages", 0, "content", 0, "text"); got != "hello" {
		t.Errorf("messages[0].content = %v", got)
	}

	// ── response translation ──
	if resp.Provider != "vertex" || resp.ID != "msg_01" {
		t.Errorf("provider/id = %s/%s", resp.Provider, resp.ID)
	}
	choice := resp.Choices[0]
	if got := choice.Message.Content.AsText(); got != "Hi there" {
		t.Errorf("content = %q", got)
	}
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %+v", choice.Message.ToolCalls)
	}
	tc := choice.Message.ToolCalls[0]
	if tc.ID != "toolu_1" || tc.Function.Name != "get_weather" || !strings.Contains(tc.Function.Arguments, "Paris") {
		t.Errorf("tool call = %+v", tc)
	}
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish = %q, want tool_calls", choice.FinishReason)
	}
	u := resp.Usage
	if u.PromptTokens != 13 || u.CompletionTokens != 9 || u.TotalTokens != 22 {
		t.Errorf("usage = %+v", u)
	}
	if u.PromptTokensDetails == nil || u.PromptTokensDetails.CachedTokens != 2 {
		t.Errorf("usage details = %+v", u.PromptTokensDetails)
	}
}

func TestClaudeStream(t *testing.T) {
	events := strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"msg_02","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}`,
		"",
		"event: content_block_stop",
		`data: {"type":"content_block_stop","index":0}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
		"",
	}, "\n")

	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "text/event-stream", events))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "claude-sonnet-4@20250514",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		acc.Add(chunk)
	}

	if !strings.HasSuffix(c.path, "/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict") {
		t.Errorf("path = %s", c.path)
	}
	if _, ok := c.body["model"]; ok {
		t.Error("stream body must not contain a model field")
	}
	if got := c.body["anthropic_version"]; got != anthropicVersion {
		t.Errorf("anthropic_version = %v", got)
	}
	if got := c.body["stream"]; got != true {
		t.Errorf("stream = %v, want true", got)
	}

	resp := acc.Response()
	if resp.ID != "msg_02" {
		t.Errorf("id = %q", resp.ID)
	}
	choice := resp.Choices[0]
	if got := choice.Message.Content.AsText(); got != "Hello" {
		t.Errorf("content = %q", got)
	}
	if choice.FinishReason != "stop" {
		t.Errorf("finish = %q, want stop", choice.FinishReason)
	}
	if resp.Usage == nil || resp.Usage.PromptTokens != 5 || resp.Usage.CompletionTokens != 2 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

// TestClaudeStreamError verifies that a mid-stream error event surfaces as a
// classified *api.Error attributed to the vertex provider (not the shared
// anthropic decoder's default).
func TestClaudeStreamError(t *testing.T) {
	events := strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"msg_03","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}`,
		"",
		"event: error",
		`data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
		"",
		"",
	}, "\n")

	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "text/event-stream", events))
	defer srv.Close()
	p := staticKeyProvider(t, srv.URL)

	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "claude-sonnet-4@20250514",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	var recvErr error
	for {
		_, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			recvErr = err
			break
		}
	}
	apiErr, ok := api.AsError(recvErr)
	if !ok {
		t.Fatalf("stream error is %T (%v), want *api.Error", recvErr, recvErr)
	}
	if apiErr.Type != api.ErrUnavailable {
		t.Errorf("type = %s, want %s", apiErr.Type, api.ErrUnavailable)
	}
	if apiErr.Provider != "vertex" {
		t.Errorf("provider = %q, want vertex", apiErr.Provider)
	}
	if !strings.Contains(apiErr.Message, "Overloaded") {
		t.Errorf("message = %q", apiErr.Message)
	}
}
