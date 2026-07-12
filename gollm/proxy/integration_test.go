package proxy

// Integration tests that boot the real proxy HTTP server (New + httptest) and
// drive real client requests through it to a scriptable fake upstream. These
// cover the end-to-end seams the per-function unit tests are blind to: the
// bytes the proxy actually emits upstream after translation, cross-deployment
// fallback and error-envelope rendering through the config+HTTP boundary,
// verbatim SSE passthrough with usage sniffing, deployment-model cost
// attribution, and in-band mid-stream failure on both surfaces.
//
// The reusable harness (proxyEnv, recordingUpstream, writeSSE, spendLogs) lives
// here and is shared by the wire-level tests below. It builds on the helpers in
// proxy_test.go (testLogger, readSSE, mustUnmarshal), which are in this package.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/based64god/gollm/anthropic"
	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/costs"
)

// ── reusable harness ────────────────────────────────────────────────────────

// proxyEnv is a booted proxy under test: the httptest.Server, the Server, and
// the master key clients authenticate with. Cleanup is registered on t.
type proxyEnv struct {
	ts        *httptest.Server
	srv       *Server
	masterKey string
}

// newProxyEnv parses cfgYAML, builds the Server, and serves it. cfgYAML is a
// full proxy config; callers interpolate upstream .URLs into api_base.
func newProxyEnv(t *testing.T, cfgYAML string) *proxyEnv {
	t.Helper()
	cfg, err := ParseConfig([]byte(cfgYAML))
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	srv, err := New(cfg, testLogger())
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	return &proxyEnv{ts: ts, srv: srv, masterKey: cfg.GeneralSettings.MasterKey}
}

// post sends a request to the proxy authenticated with the master key. Extra
// headers overlay the defaults.
func (e *proxyEnv) post(t *testing.T, path, body string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.ts.URL+path, strings.NewReader(body))
	req.Header.Set("x-api-key", e.masterKey)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	return resp
}

// spendResponse mirrors the /spend/logs payload.
type spendResponse struct {
	TotalSpend float64      `json:"total_spend"`
	Logs       []SpendEntry `json:"logs"`
}

// spendLogs reads /spend/logs (master-key gated). Entries are newest-first.
func (e *proxyEnv) spendLogs(t *testing.T) spendResponse {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.ts.URL+"/spend/logs", nil)
	req.Header.Set("Authorization", "Bearer "+e.masterKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /spend/logs: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /spend/logs status %d", resp.StatusCode)
	}
	var out spendResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode spend logs: %v", err)
	}
	return out
}

// recordingUpstream is a scriptable fake provider backend: it records the last
// request (body, headers, path) and the call count, then delegates response
// rendering to a per-test handler. One type serves OpenAI completions,
// Anthropic SSE, fail-then-succeed sequences, and mid-stream drops.
type recordingUpstream struct {
	srv *httptest.Server

	mu       sync.Mutex
	calls    int
	lastBody []byte
	lastHdr  http.Header
	lastPath string

	handler func(w http.ResponseWriter, r *http.Request, call int, body []byte)
}

func newRecordingUpstream(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, call int, body []byte)) *recordingUpstream {
	t.Helper()
	u := &recordingUpstream{handler: handler}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.calls++
		call := u.calls
		u.lastBody = append([]byte(nil), body...)
		u.lastHdr = r.Header.Clone()
		u.lastPath = r.URL.Path
		u.mu.Unlock()
		u.handler(w, r, call, body)
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func (u *recordingUpstream) callCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls
}

func (u *recordingUpstream) body() []byte {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.lastBody
}

func (u *recordingUpstream) header(k string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.lastHdr.Get(k)
}

// writeSSE emits each frame as one `data: …` SSE event, flushing between them
// so the proxy's stream reader sees them incrementally.
func writeSSE(w http.ResponseWriter, frames ...string) {
	flusher, _ := w.(http.Flusher)
	for _, f := range frames {
		fmt.Fprintf(w, "data: %s\n\n", f)
		if flusher != nil {
			flusher.Flush()
		}
	}
}

// openAICompletion renders a canned OpenAI non-streaming completion with the
// given usage — the minimal valid body the translated path needs to succeed.
func openAICompletion(promptTok, completionTok int) string {
	return fmt.Sprintf(`{"id":"chatcmpl-int","object":"chat.completion","created":1,"model":"gpt-4o",
		"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":%d,"completion_tokens":%d,"total_tokens":%d}}`,
		promptTok, completionTok, promptTok+completionTok)
}

// ── Test A: translated request bytes emitted upstream ───────────────────────

// TestTranslatedRequestBytesToOpenAIBackend asserts the exact request the proxy
// emits to an OpenAI backend for a Claude-Code-shaped /v1/messages body: the
// top-level system block becomes a leading system message, the Claude-Code
// system-ROLE message injected into messages survives (the system-role-in-
// messages quirk), tools map to OpenAI function schema, cache_control is
// stripped, and the wire model is the deployment model, not the alias.
func TestTranslatedRequestBytesToOpenAIBackend(t *testing.T) {
	upstream := newRecordingUpstream(t, func(w http.ResponseWriter, r *http.Request, call int, body []byte) {
		fmt.Fprint(w, openAICompletion(12, 4))
	})
	env := newProxyEnv(t, fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: fake-openai-key
      api_base: %s
general_settings:
  master_key: sk-master-test
`, upstream.srv.URL))

	reqBody := `{
	  "model":"claude-sonnet-4-5","max_tokens":1024,
	  "system":[{"type":"text","text":"You are Claude Code.","cache_control":{"type":"ephemeral"}}],
	  "tools":[{"name":"Bash","description":"Run a command","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}],
	  "messages":[
	    {"role":"system","content":"<system-reminder>stay on task</system-reminder>"},
	    {"role":"user","content":"say hi via bash"}
	  ]
	}`
	resp := env.post(t, "/v1/messages", reqBody, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
	_, _ = io.Copy(io.Discard, resp.Body)

	captured := upstream.body()
	if captured == nil {
		t.Fatal("upstream never received a request")
	}
	if upstream.lastPath != "/chat/completions" {
		t.Errorf("upstream path = %q, want /chat/completions", upstream.lastPath)
	}

	var up struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
		Tools []struct {
			Type     string `json:"type"`
			Function struct {
				Name       string          `json:"name"`
				Parameters json.RawMessage `json:"parameters"`
			} `json:"function"`
		} `json:"tools"`
	}
	mustUnmarshal(t, captured, &up)

	// Model is the deployment's gpt-4o, never the Claude alias.
	if !strings.Contains(up.Model, "gpt-4o") || strings.Contains(up.Model, "claude") {
		t.Errorf("upstream model = %q, want the gpt-4o deployment model", up.Model)
	}
	// Leading system message carries the top-level system text.
	if len(up.Messages) < 3 {
		t.Fatalf("upstream messages = %d, want >= 3 (2 system + user)", len(up.Messages))
	}
	if up.Messages[0].Role != "system" || !bytes.Contains(up.Messages[0].Content, []byte("You are Claude Code")) {
		t.Errorf("messages[0] = %+v, want leading system message with the top-level system text", up.Messages[0])
	}
	// The injected system-ROLE message survives as a system message.
	sawInjected := false
	for _, m := range up.Messages {
		if m.Role == "system" && bytes.Contains(m.Content, []byte("stay on task")) {
			sawInjected = true
		}
	}
	if !sawInjected {
		t.Error("the Claude-Code system-role message was dropped in translation")
	}
	// The last message is the user turn.
	last := up.Messages[len(up.Messages)-1]
	if last.Role != "user" || !bytes.Contains(last.Content, []byte("say hi via bash")) {
		t.Errorf("last message = %+v, want the user turn", last)
	}
	// Tool mapped to an OpenAI function with its JSON schema intact.
	if len(up.Tools) != 1 || up.Tools[0].Type != "function" || up.Tools[0].Function.Name != "Bash" {
		t.Errorf("tools = %+v, want one Bash function", up.Tools)
	}
	if !bytes.Contains(up.Tools[0].Function.Parameters, []byte("command")) {
		t.Errorf("tool parameters lost the schema: %s", up.Tools[0].Function.Parameters)
	}
	// cache_control is an Anthropic concept; it must not leak to an OpenAI backend.
	if bytes.Contains(captured, []byte("cache_control")) {
		t.Error("cache_control leaked into the translated OpenAI request")
	}
}

// ── Test B: cross-deployment fallback + error envelopes ─────────────────────

// TestCrossDeploymentFallback points one alias at two deployments; the first
// 500s and the router must fail over to the healthy second, recording the
// served attempt in spend. When every deployment 500s, the client receives the
// classified status in the correct envelope on both surfaces.
func TestCrossDeploymentFallback(t *testing.T) {
	badBody := `{"error":{"message":"boom","type":"server_error"}}`
	always500 := func(w http.ResponseWriter, r *http.Request, call int, body []byte) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, badBody)
	}

	t.Run("failover to healthy deployment", func(t *testing.T) {
		down := newRecordingUpstream(t, always500)
		up := newRecordingUpstream(t, func(w http.ResponseWriter, r *http.Request, call int, body []byte) {
			fmt.Fprint(w, openAICompletion(10, 5))
		})
		env := newProxyEnv(t, fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
      api_base: %s
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
      api_base: %s
general_settings:
  master_key: sk-master-test
router_settings:
  num_retries: 3
`, down.srv.URL, up.srv.URL))

		body := `{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`
		resp := env.post(t, "/v1/messages", body, nil)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			raw, _ := io.ReadAll(resp.Body)
			t.Fatalf("status %d: %s — fallback to the healthy deployment did not happen", resp.StatusCode, raw)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		if up.callCount() == 0 {
			t.Error("healthy deployment was never tried")
		}
		logs := env.spendLogs(t)
		if len(logs.Logs) == 0 || logs.Logs[0].Status != http.StatusOK {
			t.Errorf("spend did not record a 200 served attempt: %+v", logs.Logs)
		}
	})

	t.Run("all deployments down → error envelope on both surfaces", func(t *testing.T) {
		a := newRecordingUpstream(t, always500)
		b := newRecordingUpstream(t, always500)
		env := newProxyEnv(t, fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
      api_base: %s
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
      api_base: %s
general_settings:
  master_key: sk-master-test
router_settings:
  num_retries: 2
`, a.srv.URL, b.srv.URL))

		// Anthropic surface.
		body := `{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`
		resp := env.post(t, "/v1/messages", body, nil)
		if resp.StatusCode < 500 {
			t.Errorf("anthropic surface status = %d, want a 5xx", resp.StatusCode)
		}
		var aerr anthropic.ErrorResponse
		mustDecode(t, resp, &aerr)
		if aerr.Type != "error" || aerr.Error.Type == "" {
			t.Errorf("anthropic error envelope = %+v", aerr)
		}

		// OpenAI surface.
		ocBody := `{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`
		oresp := env.post(t, "/v1/chat/completions", ocBody, nil)
		if oresp.StatusCode < 500 {
			t.Errorf("openai surface status = %d, want a 5xx", oresp.StatusCode)
		}
		var oerr struct {
			Error struct {
				Message string `json:"message"`
				Type    string `json:"type"`
			} `json:"error"`
		}
		mustDecode(t, oresp, &oerr)
		if oerr.Error.Type == "" {
			t.Errorf("openai error envelope = %+v", oerr)
		}
	})
}

// ── Test C: streaming anthropic→anthropic passthrough + usage sniffing ──────

// TestStreamingPassthroughUsageSniffing points an alias at an anthropic backend
// emitting a raw Messages SSE stream and asserts the bytes reach the client
// verbatim, the forwarded request swapped the model while preserving
// cache_control and anthropic-beta, and spend records non-zero cost derived
// from the sniffed message_start + message_delta usage.
func TestStreamingPassthroughUsageSniffing(t *testing.T) {
	// Raw Anthropic Messages SSE the backend emits; message_start carries input
	// usage, message_delta carries output usage — the two events copySSESniffingUsage sniffs.
	frames := []string{
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-6-20250601","content":[],"usage":{"input_tokens":31,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
		`{"type":"message_stop"}`,
	}
	var rawStream bytes.Buffer
	for _, f := range frames {
		fmt.Fprintf(&rawStream, "data: %s\n\n", f)
	}

	upstream := newRecordingUpstream(t, func(w http.ResponseWriter, r *http.Request, call int, body []byte) {
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		for _, f := range frames {
			fmt.Fprintf(w, "data: %s\n\n", f)
			if flusher != nil {
				flusher.Flush()
			}
		}
	})
	env := newProxyEnv(t, fmt.Sprintf(`
model_list:
  - model_name: claude-opus-4-6
    params:
      model: anthropic/claude-opus-4-6-20250601
      api_key: real-anthropic-key
      api_base: %s
general_settings:
  master_key: sk-master-test
`, upstream.srv.URL))

	body := `{"model":"claude-opus-4-6","max_tokens":50,"stream":true,
		"system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}],
		"messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}]}`
	resp := env.post(t, "/v1/messages", body, map[string]string{
		"anthropic-beta": "prompt-caching-2024-07-31",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
	got, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(got, rawStream.Bytes()) {
		t.Errorf("passthrough was not verbatim:\n got %q\nwant %q", got, rawStream.Bytes())
	}

	// The forwarded request swapped alias→deployment model and preserved cache_control + beta.
	captured := upstream.body()
	var fwd struct {
		Model string `json:"model"`
	}
	mustUnmarshal(t, captured, &fwd)
	if fwd.Model != "claude-opus-4-6-20250601" {
		t.Errorf("forwarded model = %q, want the deployment model", fwd.Model)
	}
	if !bytes.Contains(captured, []byte("cache_control")) {
		t.Error("passthrough stripped cache_control — must forward verbatim")
	}
	if upstream.header("anthropic-beta") != "prompt-caching-2024-07-31" {
		t.Errorf("anthropic-beta not forwarded: %q", upstream.header("anthropic-beta"))
	}

	// Spend recorded the sniffed usage and a non-zero cost.
	logs := env.spendLogs(t)
	if len(logs.Logs) == 0 {
		t.Fatal("no spend entry recorded")
	}
	e := logs.Logs[0]
	if e.PromptTokens != 31 || e.CompletionTokens != 7 {
		t.Errorf("sniffed usage = (%d in / %d out), want 31/7", e.PromptTokens, e.CompletionTokens)
	}
	if e.Cost <= 0 {
		t.Errorf("cost = %v, want > 0 from sniffed usage", e.Cost)
	}
}

// ── Test D: cost attributed to the deployment model, not the alias ──────────

// TestCostAttributedToDeploymentModel proves the virtual-key billing invariant:
// an alias that fronts openai/gpt-4o is priced at gpt-4o's rate, not the Claude
// alias's rate. Compared against costs.Cost directly so a pricing-table update
// doesn't break the test.
func TestCostAttributedToDeploymentModel(t *testing.T) {
	const promptTok, completionTok = 12, 4
	upstream := newRecordingUpstream(t, func(w http.ResponseWriter, r *http.Request, call int, body []byte) {
		fmt.Fprint(w, openAICompletion(promptTok, completionTok))
	})
	env := newProxyEnv(t, fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
      api_base: %s
general_settings:
  master_key: sk-master-test
`, upstream.srv.URL))

	body := `{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"x"}]}`
	resp := env.post(t, "/v1/messages", body, nil)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	usage := &api.Usage{PromptTokens: promptTok, CompletionTokens: completionTok}
	wantDeployment := costs.Cost("openai/gpt-4o", usage)
	aliasCost := costs.Cost("claude-sonnet-4-5", usage)
	if wantDeployment <= 0 {
		t.Fatalf("gpt-4o has no pricing; test cannot distinguish (got %v)", wantDeployment)
	}
	if wantDeployment == aliasCost {
		t.Skip("gpt-4o and the alias price identically; nothing to distinguish")
	}

	logs := env.spendLogs(t)
	if len(logs.Logs) == 0 {
		t.Fatal("no spend entry recorded")
	}
	got := logs.Logs[0].Cost
	if got != wantDeployment {
		t.Errorf("recorded cost = %v, want the gpt-4o deployment cost %v (alias cost would be %v)", got, wantDeployment, aliasCost)
	}
}

// ── Test E: mid-stream backend failure surfaced in-band on both surfaces ────

// midStreamFailUpstream emits two valid OpenAI streaming chunks then an in-band
// {"error":…} frame and closes without [DONE]. The provider's sniffStreamError
// turns that frame into a non-EOF stream error deterministically (no socket
// hijacking), so both surfaces must surface it in-band after partial content.
func midStreamFailUpstream(t *testing.T) *recordingUpstream {
	return newRecordingUpstream(t, func(w http.ResponseWriter, r *http.Request, call int, body []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		writeSSE(w,
			`{"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"}}]}`,
			`{"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"partial answer"}}]}`,
			`{"error":{"message":"upstream exploded","type":"server_error"}}`,
		)
		// Return without [DONE]: the error frame is the terminal event.
	})
}

func TestMidStreamFailureAnthropicSurface(t *testing.T) {
	upstream := midStreamFailUpstream(t)
	env := newProxyEnv(t, fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
      api_base: %s
general_settings:
  master_key: sk-master-test
`, upstream.srv.URL))

	body := `{"model":"claude-sonnet-4-5","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"hi"}]}`
	resp := env.post(t, "/v1/messages", body, nil)
	defer resp.Body.Close()
	// Headers are long gone by the time the backend fails, so the status stays 200
	// and the failure is reported in-band.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (mid-stream failure is in-band)", resp.StatusCode)
	}
	events := readSSE(t, resp.Body)
	names := make([]string, len(events))
	for i, e := range events {
		names[i] = e.name
	}
	joined := strings.Join(names, " ")
	if !strings.Contains(joined, "message_start") {
		t.Errorf("event stream never started: %v", names)
	}
	if len(names) == 0 || names[len(names)-1] != "error" {
		t.Errorf("stream did not end with an in-band error event: %v", names)
	}
	if strings.Contains(joined, "message_stop") {
		t.Errorf("a failed stream must not emit message_stop: %v", names)
	}
	// The error event carries the api_error envelope.
	last := events[len(events)-1]
	var ev struct {
		Type  string `json:"type"`
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	mustUnmarshal(t, last.data, &ev)
	if ev.Type != "error" || ev.Error.Type == "" {
		t.Errorf("error event payload = %s", last.data)
	}

	// Spend recorded the failure with a non-2xx status.
	logs := env.spendLogs(t)
	if len(logs.Logs) == 0 || logs.Logs[0].Status == http.StatusOK {
		t.Errorf("spend did not record the mid-stream failure: %+v", logs.Logs)
	}
}

func TestMidStreamFailureOpenAISurface(t *testing.T) {
	upstream := midStreamFailUpstream(t)
	env := newProxyEnv(t, fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
      api_base: %s
general_settings:
  master_key: sk-master-test
`, upstream.srv.URL))

	body := `{"model":"claude-sonnet-4-5","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"hi"}]}`
	resp := env.post(t, "/v1/chat/completions", body, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (mid-stream failure is in-band)", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	out := string(raw)
	// The partial content made it through before the failure.
	if !strings.Contains(out, "partial answer") {
		t.Errorf("partial content was not forwarded before the failure:\n%s", out)
	}
	// The stream terminates with an in-band error object, NOT [DONE].
	if !strings.Contains(out, `"error"`) {
		t.Errorf("no in-band error object emitted:\n%s", out)
	}
	if strings.Contains(out, "[DONE]") {
		t.Errorf("a failed OpenAI stream must not emit [DONE]:\n%s", out)
	}
}

// mustDecode decodes a response body as JSON and closes it.
func mustDecode(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}
