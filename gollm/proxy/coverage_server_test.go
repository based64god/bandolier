package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/router"
)

// covSrvNoMasterServer builds a proxy with NO master_key, so admin gating is
// disabled (requireMaster returns nil) and authenticate() passes everything.
func covSrvNoMasterServer(t *testing.T, upstreamURL string) *Server {
	t.Helper()
	cfg, err := ParseConfig([]byte(fmt.Sprintf(`
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: fake-openai-key
      api_base: %s
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

// covSrvPassthroughServer maps several aliases with different provider mixes so
// the passthrough-decision helpers can be exercised without any network.
func covSrvPassthroughServer(t *testing.T) *Server {
	t.Helper()
	cfg, err := ParseConfig([]byte(`
model_list:
  - model_name: covsrv-anthropic
    params:
      model: anthropic/claude-opus-4-6-20250601
      api_key: k
  - model_name: covsrv-mixed
    params:
      model: anthropic/claude-opus-4-6-20250601
      api_key: k
      passthrough: true
  - model_name: covsrv-mixed
    params:
      model: openai/gpt-4o
      api_key: k
  - model_name: covsrv-forced-off
    params:
      model: anthropic/claude-opus-4-6-20250601
      api_key: k
      passthrough: false
  - model_name: claude-*
    params:
      model: anthropic/claude-sonnet-4-5-20250601
      api_key: k
general_settings:
  master_key: sk-master-test
`))
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	srv, err := New(cfg, testLogger())
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	return srv
}

// covSrvGet issues an authenticated GET and returns status + body.
func covSrvGet(t *testing.T, url, bearer string) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

// ── Router() ────────────────────────────────────────────────────────────────

func TestCovSrvRouterAccessor(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	var r *router.Router = srv.Router()
	if r == nil {
		t.Fatal("Router() returned nil")
	}
	// It must be the live router serving the configured alias.
	if !r.HasModel("claude-sonnet-4-5") {
		t.Errorf("router does not serve the configured alias; ModelNames=%v", r.ModelNames())
	}
}

// ── handleHealth ────────────────────────────────────────────────────────────

func TestCovSrvHealthNoAuth(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	for _, path := range []string{"/health", "/health/readiness", "/health/liveliness"} {
		// No auth header at all — health must be open.
		status, body := covSrvGet(t, ts.URL+path, "")
		if status != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", path, status)
		}
		var out map[string]any
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatalf("%s body %s: %v", path, body, err)
		}
		if out["status"] != "healthy" {
			t.Errorf("%s body = %s, want status healthy", path, body)
		}
		// Must not leak operational detail to an unauthenticated probe.
		if _, ok := out["logs"]; ok {
			t.Errorf("%s leaked logs", path)
		}
	}
}

// ── handleModels auth failure ───────────────────────────────────────────────

func TestCovSrvModelsAuthFail(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	status, body := covSrvGet(t, ts.URL+"/v1/models", "sk-wrong-key")
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", status)
	}
	var env map[string]openAIError
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("body %s: %v", body, err)
	}
	if env["error"].Type != "authentication_error" {
		t.Errorf("error type = %q, want authentication_error", env["error"].Type)
	}
}

// ── requireMaster gating ────────────────────────────────────────────────────

func TestCovSrvAdminGatingNonMaster(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// A non-master credential must be forbidden on every admin endpoint.
	cases := []struct {
		method, path string
	}{
		{http.MethodGet, "/key/info?key=whatever"},
		{http.MethodGet, "/spend/logs"},
		{http.MethodPost, "/key/generate"},
	}
	for _, c := range cases {
		var bodyReader io.Reader
		if c.method == http.MethodPost {
			bodyReader = strings.NewReader(`{"key_alias":"x"}`)
		}
		req, _ := http.NewRequest(c.method, ts.URL+c.path, bodyReader)
		req.Header.Set("Authorization", "Bearer sk-not-the-master")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want 403; body=%s", c.method, c.path, resp.StatusCode, body)
		}
		var env map[string]openAIError
		_ = json.Unmarshal(body, &env)
		if env["error"].Type != "permission_error" {
			t.Errorf("%s %s error type = %q, want permission_error", c.method, c.path, env["error"].Type)
		}
	}
}

func TestCovSrvAdminGatingMasterSucceeds(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// /spend/logs with the master key is admitted.
	if status, _ := covSrvGet(t, ts.URL+"/spend/logs", "sk-master-test"); status != http.StatusOK {
		t.Fatalf("/spend/logs master status = %d, want 200", status)
	}
	// /key/generate with the master key mints a key.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/key/generate", strings.NewReader(`{"key_alias":"cov"}`))
	req.Header.Set("Authorization", "Bearer sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var vk VirtualKey
	_ = json.NewDecoder(resp.Body).Decode(&vk)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(vk.Key, "sk-gollm-") {
		t.Fatalf("generate status=%d key=%q", resp.StatusCode, vk.Key)
	}
}

func TestCovSrvAdminGatingNoMasterOpen(t *testing.T) {
	srv := covSrvNoMasterServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// With no master key, requireMaster returns nil: admin endpoints are open
	// even without any credential.
	if status, _ := covSrvGet(t, ts.URL+"/spend/logs", ""); status != http.StatusOK {
		t.Fatalf("/spend/logs (no master) status = %d, want 200", status)
	}
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/key/generate", strings.NewReader(`{"key_alias":"x"}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var vk VirtualKey
	_ = json.NewDecoder(resp.Body).Decode(&vk)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(vk.Key, "sk-gollm-") {
		t.Fatalf("generate (no master) status=%d key=%q", resp.StatusCode, vk.Key)
	}
}

// ── handleKeyGenerate ───────────────────────────────────────────────────────

func TestCovSrvKeyGenerateValid(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/key/generate",
		strings.NewReader(`{"key_alias":"covgen","max_budget":5,"models":["claude-sonnet-4-5"]}`))
	req.Header.Set("Authorization", "Bearer sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var vk VirtualKey
	if err := json.NewDecoder(resp.Body).Decode(&vk); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(vk.Key, "sk-gollm-") {
		t.Errorf("key = %q, want sk-gollm- prefix", vk.Key)
	}
	if vk.Alias != "covgen" || vk.MaxBudget != 5 {
		t.Errorf("vk = %+v, alias/budget not echoed", vk)
	}
}

func TestCovSrvKeyGenerateMalformed(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/key/generate", strings.NewReader(`{not valid json`))
	req.Header.Set("Authorization", "Bearer sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

// ── handleKeyInfo ───────────────────────────────────────────────────────────

func TestCovSrvKeyInfoFound(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// Mint a key, then look it up.
	gen, _ := http.NewRequest(http.MethodPost, ts.URL+"/key/generate",
		strings.NewReader(`{"key_alias":"covinfo","max_budget":2}`))
	gen.Header.Set("Authorization", "Bearer sk-master-test")
	genResp, err := http.DefaultClient.Do(gen)
	if err != nil {
		t.Fatal(err)
	}
	var made VirtualKey
	_ = json.NewDecoder(genResp.Body).Decode(&made)
	genResp.Body.Close()

	status, body := covSrvGet(t, ts.URL+"/key/info?key="+made.Key, "sk-master-test")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var got VirtualKey
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Key != made.Key || got.Alias != "covinfo" || got.MaxBudget != 2 {
		t.Errorf("key info = %+v, want the minted key", got)
	}
}

func TestCovSrvKeyInfoUnknown(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	status, body := covSrvGet(t, ts.URL+"/key/info?key=sk-gollm-does-not-exist", "sk-master-test")
	if status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", status, body)
	}
	var env map[string]openAIError
	_ = json.Unmarshal(body, &env)
	if env["error"].Type != "not_found_error" {
		t.Errorf("error type = %q, want not_found_error", env["error"].Type)
	}
}

// ── handleSpendLogs ─────────────────────────────────────────────────────────

func TestCovSrvSpendLogs(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// Fresh server: no logs yet.
	status, body := covSrvGet(t, ts.URL+"/spend/logs", "sk-master-test")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	var empty struct {
		TotalSpend float64      `json:"total_spend"`
		Logs       []SpendEntry `json:"logs"`
	}
	if err := json.Unmarshal(body, &empty); err != nil {
		t.Fatalf("body %s: %v", body, err)
	}
	if len(empty.Logs) != 0 {
		t.Fatalf("fresh server logs = %d, want 0", len(empty.Logs))
	}

	// Drive three requests through the proxy so entries accumulate.
	for i := 0; i < 3; i++ {
		reqBody := `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`
		r, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", strings.NewReader(reqBody))
		r.Header.Set("Authorization", "Bearer sk-master-test")
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("drive request %d status = %d", i, res.StatusCode)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}

	// Default (no limit): all three logs, non-empty, and a positive total.
	status, body = covSrvGet(t, ts.URL+"/spend/logs", "sk-master-test")
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	var all struct {
		TotalSpend float64      `json:"total_spend"`
		Logs       []SpendEntry `json:"logs"`
	}
	mustUnmarshal(t, body, &all)
	if len(all.Logs) != 3 {
		t.Fatalf("logs = %d, want 3", len(all.Logs))
	}
	if all.TotalSpend <= 0 {
		t.Errorf("total_spend = %v, want > 0 (gpt-4o is priced)", all.TotalSpend)
	}
	if all.Logs[0].Endpoint != "chat" {
		t.Errorf("newest log endpoint = %q, want chat", all.Logs[0].Endpoint)
	}

	// limit query bounds the returned slice.
	status, body = covSrvGet(t, ts.URL+"/spend/logs?limit=2", "sk-master-test")
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	var bounded struct {
		Logs []SpendEntry `json:"logs"`
	}
	mustUnmarshal(t, body, &bounded)
	if len(bounded.Logs) != 2 {
		t.Errorf("limited logs = %d, want 2", len(bounded.Logs))
	}
}

// ── keyAlias ────────────────────────────────────────────────────────────────

func TestCovSrvKeyAlias(t *testing.T) {
	cases := []struct {
		name string
		vk   *VirtualKey
		want string
	}{
		{"nil", nil, ""},
		{"alias-set", &VirtualKey{Alias: "prod", Key: "sk-gollm-abcdefghijklmnop"}, "prod"},
		{"no-alias-long", &VirtualKey{Key: "sk-gollm-abcdef123456"}, "…123456"},
		{"no-alias-short", &VirtualKey{Key: "abc123"}, "abc123"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := keyAlias(c.vk); got != c.want {
				t.Errorf("keyAlias = %q, want %q", got, c.want)
			}
		})
	}
}

// ── entriesForAlias / passthroughEligible ───────────────────────────────────

func TestCovSrvPassthroughEligible(t *testing.T) {
	srv := covSrvPassthroughServer(t)
	cases := []struct {
		alias string
		want  bool
	}{
		{"covsrv-anthropic", true},   // all-anthropic pool
		{"covsrv-mixed", false},      // an openai deployment shares the alias
		{"covsrv-forced-off", false}, // passthrough explicitly disabled
		{"covsrv-unknown", false},    // no entries resolve
		{"claude-sonnet-4-5", true},  // wildcard "claude-*" → anthropic backend
	}
	for _, c := range cases {
		if got := srv.passthroughEligible(c.alias); got != c.want {
			t.Errorf("passthroughEligible(%q) = %v, want %v", c.alias, got, c.want)
		}
	}
}

func TestCovSrvEntriesForAlias(t *testing.T) {
	srv := covSrvPassthroughServer(t)

	// Exact match.
	exact := srv.entriesForAlias("covsrv-anthropic")
	if len(exact) != 1 || exact[0].Params.Model != "anthropic/claude-opus-4-6-20250601" {
		t.Fatalf("exact entries = %+v", exact)
	}

	// Wildcard match: "claude-anything" is served by the "claude-*" entry.
	wild := srv.entriesForAlias("claude-anything")
	if len(wild) != 1 || wild[0].Params.Model != "anthropic/claude-sonnet-4-5-20250601" {
		t.Fatalf("wildcard entries = %+v", wild)
	}

	// Unknown alias resolves to nothing.
	if got := srv.entriesForAlias("covsrv-unknown"); len(got) != 0 {
		t.Errorf("unknown entries = %+v, want empty", got)
	}
}

// ── warnMixedPassthrough ────────────────────────────────────────────────────

func TestCovSrvWarnMixedPassthroughLogs(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	cfg, err := ParseConfig([]byte(`
model_list:
  - model_name: covsrv-warnmix
    params:
      model: anthropic/claude-opus-4-6-20250601
      api_key: k
      passthrough: true
  - model_name: covsrv-warnmix
    params:
      model: openai/gpt-4o
      api_key: k
general_settings:
  master_key: sk-master-test
`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(cfg, logger); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if !strings.Contains(out, "passthrough requested but disabled") {
		t.Errorf("expected mixed-passthrough warning, got: %s", out)
	}
	if !strings.Contains(out, "covsrv-warnmix") {
		t.Errorf("warning does not name the offending alias: %s", out)
	}
}

func TestCovSrvWarnMixedPassthroughSilentWhenEligible(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	// An all-anthropic alias that opts into passthrough is eligible — no warning.
	cfg, err := ParseConfig([]byte(`
model_list:
  - model_name: covsrv-clean
    params:
      model: anthropic/claude-opus-4-6-20250601
      api_key: k
      passthrough: true
general_settings:
  master_key: sk-master-test
`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(cfg, logger); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "passthrough requested but disabled") {
		t.Errorf("unexpected mixed-passthrough warning for eligible alias: %s", buf.String())
	}
}

// ── chatStream ──────────────────────────────────────────────────────────────

func TestCovSrvChatStreamNoUsage(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// stream:true, no stream_options → the usage-only chunk must be suppressed.
	body := `{"model":"claude-sonnet-4-5","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}

	events := readSSE(t, resp.Body)
	var sawDone bool
	var content strings.Builder
	for _, e := range events {
		if string(e.data) == "[DONE]" {
			sawDone = true
			continue
		}
		var chunk api.ChatChunk
		mustUnmarshal(t, e.data, &chunk)
		if chunk.Object != "chat.completion.chunk" {
			t.Errorf("chunk object = %q", chunk.Object)
		}
		// Usage-only chunk (choices:[] + usage) must not reach a client that
		// didn't ask for it.
		if chunk.Usage != nil {
			t.Errorf("usage chunk leaked to client that didn't request include_usage: %s", e.data)
		}
		for _, c := range chunk.Choices {
			content.WriteString(c.Delta.Content)
		}
	}
	if !sawDone {
		t.Error("stream did not terminate with data: [DONE]")
	}
	if !strings.Contains(content.String(), "Let me run that.") {
		t.Errorf("streamed content = %q, want the backend text", content.String())
	}
}

func TestCovSrvChatStreamIncludeUsage(t *testing.T) {
	upstream := fakeOpenAI(t)
	defer upstream.Close()
	srv := newTestServer(t, upstream.URL)
	ts := httptest.NewServer(srv)
	defer ts.Close()

	// stream_options.include_usage:true → the usage-only final chunk is forwarded.
	body := `{"model":"claude-sonnet-4-5","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"hi"}]}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-master-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}

	events := readSSE(t, resp.Body)
	var sawDone bool
	var sawUsage bool
	for _, e := range events {
		if string(e.data) == "[DONE]" {
			sawDone = true
			continue
		}
		var chunk api.ChatChunk
		mustUnmarshal(t, e.data, &chunk)
		if chunk.Usage != nil {
			sawUsage = true
			if chunk.Usage.TotalTokens != 48 {
				t.Errorf("usage total_tokens = %d, want 48", chunk.Usage.TotalTokens)
			}
		}
	}
	if !sawDone {
		t.Error("stream did not terminate with data: [DONE]")
	}
	if !sawUsage {
		t.Error("include_usage:true but no usage chunk was forwarded")
	}
}

// ── handleEmbeddings validation ─────────────────────────────────────────────

func TestCovSrvEmbeddingsValidation(t *testing.T) {
	srv := newTestServer(t, "http://127.0.0.1:0")
	ts := httptest.NewServer(srv)
	defer ts.Close()

	post := func(body, bearer string) (int, map[string]openAIError) {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/embeddings", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+bearer)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var env map[string]openAIError
		_ = json.NewDecoder(resp.Body).Decode(&env)
		return resp.StatusCode, env
	}

	// Missing model → 400 (checked before auth).
	if status, env := post(`{"input":"hi"}`, "sk-master-test"); status != http.StatusBadRequest {
		t.Errorf("missing model status = %d, want 400 (%+v)", status, env)
	}
	// Unknown model → 404.
	if status, env := post(`{"model":"no-such-model","input":"hi"}`, "sk-master-test"); status != http.StatusNotFound {
		t.Errorf("unknown model status = %d, want 404 (%+v)", status, env)
	} else if env["error"].Type != "not_found_error" {
		t.Errorf("unknown model error type = %q", env["error"].Type)
	}
	// Configured model but wrong credential → 401.
	if status, env := post(`{"model":"claude-sonnet-4-5","input":"hi"}`, "sk-wrong"); status != http.StatusUnauthorized {
		t.Errorf("wrong auth status = %d, want 401 (%+v)", status, env)
	} else if env["error"].Type != "authentication_error" {
		t.Errorf("wrong auth error type = %q", env["error"].Type)
	}
}
