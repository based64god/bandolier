package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/based64god/gollm/anthropic"
)

// testLogger silences request logging in tests.
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeOpenAI is a minimal OpenAI-compatible backend: non-streaming returns a
// canned completion; streaming emits text then a two-fragment tool call, the
// way api.openai.com actually chunks.
func fakeOpenAI(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer fake-openai-key" {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"error":{"message":"bad key","type":"invalid_request_error"}}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(body, &req)

		if stream, _ := req["stream"].(bool); !stream {
			fmt.Fprint(w, `{"id":"chatcmpl-1","object":"chat.completion","created":1,"model":"gpt-4o",
				"choices":[{"index":0,"message":{"role":"assistant","content":"non-streamed answer"},"finish_reason":"stop"}],
				"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}`)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		chunks := []string{
			`{"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"}}]}`,
			`{"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Let me run that."}}]}`,
			`{"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x1","type":"function","function":{"name":"Bash","arguments":""}}]}}]}`,
			`{"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]}}]}`,
			`{"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"echo hi\"}"}}]}}]}`,
			`{"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":30,"completion_tokens":18,"total_tokens":48}}`,
		}
		flusher := w.(http.Flusher)
		for _, c := range chunks {
			fmt.Fprintf(w, "data: %s\n\n", c)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
}

// newTestServer builds a proxy mapping claude-sonnet-4-5 → the fake OpenAI
// backend, with master-key auth on.
func newTestServer(t *testing.T, upstreamURL string) *Server {
	t.Helper()
	cfg, err := ParseConfig([]byte(fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: fake-openai-key
      api_base: %s
general_settings:
  master_key: sk-master-test
`, upstreamURL)))
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	srv, err := New(cfg, testLogger())
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	return srv
}

// claudeCodeBody is the shape Claude Code sends: Anthropic wire format with
// system blocks, cache_control, tools, and streaming on.
const claudeCodeBody = `{
  "model": "claude-sonnet-4-5",
  "max_tokens": 8096,
  "stream": true,
  "system": [{"type":"text","text":"You are Claude Code.","cache_control":{"type":"ephemeral"}}],
  "tools": [{"name":"Bash","description":"Run a command","input_schema":{"type":"object","properties":{"command":{"type":"string"}}}}],
  "messages": [{"role":"user","content":"say hi via bash"}]
}`

// TestClaudeCodeStreamingToolUse is the core e2e: an Anthropic-format
// streaming tool-use request served by an OpenAI backend, verified at the
// Messages API event level.
func TestClaudeCodeStreamingToolUse(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/messages", strings.NewReader(claudeCodeBody))
	// Claude Code authenticates with x-api-key (ANTHROPIC_API_KEY) or a
	// bearer token (ANTHROPIC_AUTH_TOKEN); exercise x-api-key here.
	req.Header.Set("x-api-key", "sk-master-test")
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}

	events := readSSE(t, resp.Body)
	names := make([]string, len(events))
	for i, e := range events {
		names[i] = e.name
	}
	wantOrder := []string{
		"message_start",
		"content_block_start", "content_block_delta", "content_block_stop", // text
		"content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // tool
		"message_delta", "message_stop",
	}
	if strings.Join(names, " ") != strings.Join(wantOrder, " ") {
		t.Fatalf("event order:\n got %v\nwant %v", names, wantOrder)
	}

	// message_start must echo the requested alias, not the backend model.
	var ms struct {
		Message anthropic.MessagesResponse `json:"message"`
	}
	mustUnmarshal(t, events[0].data, &ms)
	if ms.Message.Model != "claude-sonnet-4-5" {
		t.Errorf("message_start model = %q, want the alias", ms.Message.Model)
	}

	// Tool block: name + id survive; fragments reassemble the arguments.
	var tbs struct {
		ContentBlock anthropic.ContentBlock `json:"content_block"`
	}
	mustUnmarshal(t, events[4].data, &tbs)
	if tbs.ContentBlock.Type != "tool_use" || tbs.ContentBlock.Name != "Bash" || tbs.ContentBlock.ID != "call_x1" {
		t.Errorf("tool block = %+v", tbs.ContentBlock)
	}
	var frag1, frag2 struct {
		Delta anthropic.EventDelta `json:"delta"`
	}
	mustUnmarshal(t, events[5].data, &frag1)
	mustUnmarshal(t, events[6].data, &frag2)
	if got := frag1.Delta.PartialJSON + frag2.Delta.PartialJSON; got != `{"command":"echo hi"}` {
		t.Errorf("reassembled arguments = %q", got)
	}

	// message_delta: stop_reason tool_use + usage from the backend.
	var md struct {
		Delta anthropic.EventDelta `json:"delta"`
		Usage anthropic.Usage      `json:"usage"`
	}
	mustUnmarshal(t, events[8].data, &md)
	if md.Delta.StopReason != "tool_use" {
		t.Errorf("stop_reason = %q", md.Delta.StopReason)
	}
	if md.Usage.OutputTokens != 18 {
		t.Errorf("output_tokens = %d", md.Usage.OutputTokens)
	}
}

func TestMessagesNonStreaming(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	body := `{"model":"claude-sonnet-4-5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-master-test")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var mresp anthropic.MessagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&mresp); err != nil {
		t.Fatal(err)
	}
	if mresp.Type != "message" || mresp.Role != "assistant" {
		t.Errorf("envelope = %+v", mresp)
	}
	if mresp.Model != "claude-sonnet-4-5" {
		t.Errorf("model echo = %q", mresp.Model)
	}
	if len(mresp.Content) != 1 || mresp.Content[0].Text != "non-streamed answer" {
		t.Errorf("content = %+v", mresp.Content)
	}
	if mresp.StopReason != "end_turn" {
		t.Errorf("stop_reason = %q", mresp.StopReason)
	}
	if mresp.Usage == nil || mresp.Usage.InputTokens != 12 || mresp.Usage.OutputTokens != 4 {
		t.Errorf("usage = %+v", mresp.Usage)
	}
}

func TestMessagesAuthAndModelErrors(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// Wrong key → 401 in Anthropic envelope.
	body := `{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"x"}]}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/messages", strings.NewReader(body))
	req.Header.Set("x-api-key", "wrong")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var envelope anthropic.ErrorResponse
	_ = json.NewDecoder(resp.Body).Decode(&envelope)
	if envelope.Type != "error" || envelope.Error.Type != "authentication_error" {
		t.Errorf("envelope = %+v", envelope)
	}

	// Unknown model → 404 not_found_error.
	body = `{"model":"claude-nonexistent","max_tokens":10,"messages":[{"role":"user","content":"x"}]}`
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/v1/messages", strings.NewReader(body))
	req.Header.Set("x-api-key", "sk-master-test")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", resp2.StatusCode)
	}
}

func TestCountTokensEstimate(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	body := `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"tell me about tokens and how they are counted"}]}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/messages/count_tokens", strings.NewReader(body))
	req.Header.Set("x-api-key", "sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out anthropic.CountTokensResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.InputTokens <= 0 {
		t.Errorf("input_tokens = %d, want > 0", out.InputTokens)
	}
}

// TestPassthroughPreservesBody verifies the anthropic→anthropic path forwards
// the request verbatim (cache_control intact) with only the model swapped.
func TestPassthroughPreservesBody(t *testing.T) {
	var captured []byte
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("x-api-key") != "real-anthropic-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		captured, _ = io.ReadAll(r.Body)
		fmt.Fprint(w, `{"id":"msg_up","type":"message","role":"assistant","model":"claude-opus-4-6",
			"content":[{"type":"text","text":"passthrough works"}],"stop_reason":"end_turn",
			"usage":{"input_tokens":9,"output_tokens":3,"cache_read_input_tokens":100}}`)
	}))
	defer backend.Close()

	cfg, err := ParseConfig([]byte(fmt.Sprintf(`
model_list:
  - model_name: claude-opus-4-6
    params:
      model: anthropic/claude-opus-4-6-20250601
      api_key: real-anthropic-key
      api_base: %s
general_settings:
  master_key: sk-master-test
`, backend.URL)))
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(cfg, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	body := `{"model":"claude-opus-4-6","max_tokens":50,
		"system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}],
		"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":{"type":"ephemeral"}}]}]}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/messages", strings.NewReader(body))
	req.Header.Set("x-api-key", "sk-master-test")
	req.Header.Set("anthropic-beta", "prompt-caching-2024-07-31")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
	var got map[string]any
	if err := json.Unmarshal(captured, &got); err != nil {
		t.Fatalf("captured body: %v", err)
	}
	if got["model"] != "claude-opus-4-6-20250601" {
		t.Errorf("forwarded model = %v, want deployment model", got["model"])
	}
	if !bytes.Contains(captured, []byte(`"cache_control"`)) {
		t.Error("cache_control was stripped — passthrough must forward verbatim")
	}
	var mresp anthropic.MessagesResponse
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &mresp); err != nil {
		t.Fatal(err)
	}
	if len(mresp.Content) != 1 || mresp.Content[0].Text != "passthrough works" {
		t.Errorf("response = %s", raw)
	}
}

func TestVirtualKeyBudgetFlow(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// Mint a key with a microscopic budget.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/key/generate",
		strings.NewReader(`{"key_alias":"tester","max_budget":0.000001}`))
	req.Header.Set("Authorization", "Bearer sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var vk VirtualKey
	_ = json.NewDecoder(resp.Body).Decode(&vk)
	resp.Body.Close()
	if !strings.HasPrefix(vk.Key, "sk-gollm-") {
		t.Fatalf("key = %q", vk.Key)
	}

	send := func() int {
		body := `{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"x"}]}`
		r, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/messages", strings.NewReader(body))
		r.Header.Set("x-api-key", vk.Key)
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, res.Body)
		return res.StatusCode
	}

	if got := send(); got != http.StatusOK {
		t.Fatalf("first call status = %d", got)
	}
	// gpt-4o has real pricing, so the canned usage (12 in / 4 out) exceeds the
	// budget; the next call must be refused.
	if got := send(); got != http.StatusTooManyRequests {
		t.Fatalf("second call status = %d, want budget refusal", got)
	}
}

func TestOpenAIEndpointAndModels(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	body := `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out["object"] != "chat.completion" {
		t.Errorf("object = %v", out["object"])
	}

	mreq, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/models", nil)
	mreq.Header.Set("Authorization", "Bearer sk-master-test")
	mresp, err := http.DefaultClient.Do(mreq)
	if err != nil {
		t.Fatal(err)
	}
	defer mresp.Body.Close()
	var models struct {
		Data []struct{ ID string } `json:"data"`
	}
	_ = json.NewDecoder(mresp.Body).Decode(&models)
	if len(models.Data) != 1 || models.Data[0].ID != "claude-sonnet-4-5" {
		t.Errorf("models = %+v", models)
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

type sseEvent struct {
	name string
	data []byte
}

func readSSE(t *testing.T, r io.Reader) []sseEvent {
	t.Helper()
	var events []sseEvent
	var cur sseEvent
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			if cur.name != "" || cur.data != nil {
				events = append(events, cur)
			}
			cur = sseEvent{}
		case strings.HasPrefix(line, "event: "):
			cur.name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			cur.data = append(cur.data, strings.TrimPrefix(line, "data: ")...)
		}
	}
	if cur.name != "" || cur.data != nil {
		events = append(events, cur)
	}
	return events
}

func mustUnmarshal(t *testing.T, data []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("unmarshal %s: %v", data, err)
	}
}
