package proxy

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/costs"
)

// covRenApproxEq reports whether two USD amounts are equal within a tiny
// tolerance (float accumulation in costs.Cost).
func covRenApproxEq(a, b float64) bool {
	return math.Abs(a-b) < 1e-12
}

// covRenPricingServer builds a proxy whose "claude-sonnet-4-5" alias maps to
// openai/gpt-4o. Both the alias and the deployment model are independently
// priceable at *different* rates, which lets pricing tests prove which id was
// actually used. No backend is dialed by the pure pricing helpers, so the
// api_base need not be reachable.
func covRenPricingServer(t *testing.T) *Server {
	t.Helper()
	return newTestServer(t, "http://127.0.0.1:0")
}

// ── errorStatus ─────────────────────────────────────────────────────────────

func TestCovRenErrorStatus(t *testing.T) {
	if got := errorStatus(&api.Error{Type: api.ErrRateLimit, StatusCode: 429}); got != http.StatusTooManyRequests {
		t.Errorf("classified error status = %d, want 429", got)
	}
	// api.Error with a zero StatusCode falls through to the 500 default.
	if got := errorStatus(&api.Error{Type: api.ErrBadRequest, StatusCode: 0}); got != http.StatusInternalServerError {
		t.Errorf("zero-status api.Error = %d, want 500", got)
	}
	// A plain, unclassified error is a 500.
	if got := errorStatus(errors.New("boom")); got != http.StatusInternalServerError {
		t.Errorf("plain error status = %d, want 500", got)
	}
}

// ── anthropicAuthErrType ────────────────────────────────────────────────────

func TestCovRenAnthropicAuthErrType(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{http.StatusUnauthorized, "authentication_error"},
		{http.StatusForbidden, "permission_error"},
		{http.StatusTooManyRequests, "rate_limit_error"},
		{http.StatusBadRequest, "invalid_request_error"},
		{http.StatusInternalServerError, "invalid_request_error"},
	}
	for _, c := range cases {
		if got := anthropicAuthErrType(c.status); got != c.want {
			t.Errorf("anthropicAuthErrType(%d) = %q, want %q", c.status, got, c.want)
		}
	}
}

// ── swapJSONField ───────────────────────────────────────────────────────────

func TestCovRenSwapJSONField(t *testing.T) {
	in := []byte(`{"model":"alias","max_tokens":5,"stream":true,"nested":{"a":1}}`)
	out, err := swapJSONField(in, "model", "real-model")
	if err != nil {
		t.Fatalf("swapJSONField: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("result not JSON: %v", err)
	}
	if m["model"] != "real-model" {
		t.Errorf("model = %v, want real-model", m["model"])
	}
	// Untouched fields survive verbatim.
	if m["max_tokens"] != float64(5) {
		t.Errorf("max_tokens = %v, want 5", m["max_tokens"])
	}
	if m["stream"] != true {
		t.Errorf("stream = %v, want true", m["stream"])
	}
	nested, ok := m["nested"].(map[string]any)
	if !ok || nested["a"] != float64(1) {
		t.Errorf("nested = %v, want {a:1}", m["nested"])
	}

	if _, err := swapJSONField([]byte(`{not json`), "model", "x"); err == nil {
		t.Error("swapJSONField(invalid JSON) = nil error, want error")
	}
}

// ── copySSESniffingUsage ────────────────────────────────────────────────────

func TestCovRenCopySSESniffingUsage(t *testing.T) {
	sse := "event: message_start\n" +
		`data: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":25,"output_tokens":1}}}` + "\n" +
		"\n" +
		"event: message_delta\n" +
		`data: {"type":"message_delta","usage":{"output_tokens":40}}` + "\n" +
		"\n"

	rec := httptest.NewRecorder()
	usage := copySSESniffingUsage(rec, strings.NewReader(sse))
	if usage == nil {
		t.Fatal("usage = nil, want accumulated usage")
	}
	// input carried by message_start, output overwritten by message_delta.
	if usage.InputTokens != 25 {
		t.Errorf("InputTokens = %d, want 25", usage.InputTokens)
	}
	if usage.OutputTokens != 40 {
		t.Errorf("OutputTokens = %d, want 40", usage.OutputTokens)
	}
	// Bytes must pass through verbatim.
	if got := rec.Body.String(); got != sse {
		t.Errorf("copied bytes = %q, want %q", got, sse)
	}
}

func TestCovRenCopySSESniffingUsageNoUsage(t *testing.T) {
	sse := "event: ping\n" + `data: {"type":"ping"}` + "\n\n"
	rec := httptest.NewRecorder()
	usage := copySSESniffingUsage(rec, strings.NewReader(sse))
	if usage != nil {
		t.Errorf("usage = %+v, want nil for a body with no usage events", usage)
	}
	// Still copies the bytes through unchanged.
	if got := rec.Body.String(); got != sse {
		t.Errorf("copied bytes = %q, want %q", got, sse)
	}
}

// ── openAIErrorEnvelope ─────────────────────────────────────────────────────

func TestCovRenOpenAIErrorEnvelope(t *testing.T) {
	// Plain error → generic api_error, no code/param.
	plain := openAIErrorEnvelope(errors.New("boom"))["error"]
	if plain.Message != "boom" || plain.Type != "api_error" {
		t.Errorf("plain envelope = %+v", plain)
	}
	if plain.Code != "" || plain.Param != "" {
		t.Errorf("plain envelope leaked code/param = %+v", plain)
	}

	// Classified error → fields mapped from the api.Error.
	apiErr := &api.Error{
		Type:       api.ErrRateLimit,
		StatusCode: 429,
		Message:    "slow down",
		Code:       "rate_limited",
		Param:      "model",
	}
	mapped := openAIErrorEnvelope(apiErr)["error"]
	if mapped.Message != "slow down" {
		t.Errorf("message = %q, want slow down", mapped.Message)
	}
	if mapped.Type != "rate_limit_error" {
		t.Errorf("type = %q, want rate_limit_error", mapped.Type)
	}
	if mapped.Code != "rate_limited" {
		t.Errorf("code = %q, want rate_limited", mapped.Code)
	}
	if mapped.Param != "model" {
		t.Errorf("param = %q, want model", mapped.Param)
	}
}

// ── writeOpenAIError ────────────────────────────────────────────────────────

func TestCovRenWriteOpenAIError(t *testing.T) {
	cases := []struct {
		status   int
		wantType string
	}{
		{http.StatusUnauthorized, "authentication_error"},
		{http.StatusForbidden, "permission_error"},
		{http.StatusNotFound, "not_found_error"},
		{http.StatusTooManyRequests, "rate_limit_error"},
		{http.StatusBadRequest, "invalid_request_error"},
		{http.StatusInternalServerError, "invalid_request_error"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		writeOpenAIError(rec, c.status, "the message")
		if rec.Code != c.status {
			t.Errorf("status %d: recorder code = %d", c.status, rec.Code)
		}
		var env map[string]openAIError
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("status %d: body not JSON: %v", c.status, err)
		}
		got := env["error"]
		if got.Type != c.wantType {
			t.Errorf("status %d: type = %q, want %q", c.status, got.Type, c.wantType)
		}
		if got.Message != "the message" {
			t.Errorf("status %d: message = %q", c.status, got.Message)
		}
	}
}

func TestCovRenWriteOpenAIErrorFrom(t *testing.T) {
	err := &api.Error{
		Type:       api.ErrPermission,
		StatusCode: http.StatusForbidden,
		Message:    "no access",
		Code:       "denied",
	}
	rec := httptest.NewRecorder()
	writeOpenAIErrorFrom(rec, err)
	// Status comes from errorStatus(err).
	if rec.Code != http.StatusForbidden {
		t.Errorf("recorder code = %d, want 403", rec.Code)
	}
	var env map[string]openAIError
	if uerr := json.Unmarshal(rec.Body.Bytes(), &env); uerr != nil {
		t.Fatalf("body not JSON: %v", uerr)
	}
	got := env["error"]
	if got.Type != "permission_error" || got.Message != "no access" || got.Code != "denied" {
		t.Errorf("envelope = %+v", got)
	}

	// A plain error → 500 status, api_error envelope.
	rec2 := httptest.NewRecorder()
	writeOpenAIErrorFrom(rec2, errors.New("kaboom"))
	if rec2.Code != http.StatusInternalServerError {
		t.Errorf("plain error code = %d, want 500", rec2.Code)
	}
	var env2 map[string]openAIError
	_ = json.Unmarshal(rec2.Body.Bytes(), &env2)
	if env2["error"].Type != "api_error" || env2["error"].Message != "kaboom" {
		t.Errorf("plain envelope = %+v", env2["error"])
	}
}

// ── decodeChatRequest ───────────────────────────────────────────────────────

func TestCovRenDecodeChatRequest(t *testing.T) {
	body := []byte(`{
		"model":"claude-sonnet-4-5",
		"messages":[{"role":"user","content":"hi"}],
		"stream":true,
		"store":true,
		"metadata":{"trace":"abc"}
	}`)
	var req api.ChatRequest
	if err := decodeChatRequest(body, &req); err != nil {
		t.Fatalf("decodeChatRequest: %v", err)
	}
	// Modeled fields parsed onto the struct.
	if req.Model != "claude-sonnet-4-5" {
		t.Errorf("model = %q", req.Model)
	}
	if !req.Stream {
		t.Error("stream = false, want true")
	}
	if len(req.Messages) != 1 || req.Messages[0].Role != "user" {
		t.Errorf("messages = %+v", req.Messages)
	}
	// Unmodeled keys land in Extra.
	if req.Extra["store"] != true {
		t.Errorf("Extra[store] = %v, want true", req.Extra["store"])
	}
	meta, ok := req.Extra["metadata"].(map[string]any)
	if !ok || meta["trace"] != "abc" {
		t.Errorf("Extra[metadata] = %v", req.Extra["metadata"])
	}
	// Modeled keys must NOT be duplicated into Extra.
	for _, k := range []string{"model", "messages", "stream"} {
		if _, dup := req.Extra[k]; dup {
			t.Errorf("modeled key %q duplicated into Extra", k)
		}
	}

	// Invalid top-level JSON → error.
	if err := decodeChatRequest([]byte(`{bad json`), &api.ChatRequest{}); err == nil {
		t.Error("decodeChatRequest(invalid) = nil error, want error")
	}
}

// ── recordStreamUsage ───────────────────────────────────────────────────────

func TestCovRenRecordStreamUsage(t *testing.T) {
	var srv Server // receiver is unused by recordStreamUsage

	// usage != nil → token counts copied straight from usage.
	entry := SpendEntry{}
	srv.recordStreamUsage(&entry, &api.Usage{PromptTokens: 30, CompletionTokens: 18}, 999)
	if entry.PromptTokens != 30 || entry.CompletionTokens != 18 {
		t.Errorf("with usage: tokens = %d/%d, want 30/18", entry.PromptTokens, entry.CompletionTokens)
	}
	if entry.Error != "" {
		t.Errorf("with usage: Error = %q, want empty", entry.Error)
	}

	// usage == nil, chars > 0 → estimate ~chars/4 and annotate Error.
	entry2 := SpendEntry{}
	srv.recordStreamUsage(&entry2, nil, 10) // (10+3)/4 = 3
	if entry2.CompletionTokens != 3 {
		t.Errorf("estimate: CompletionTokens = %d, want 3", entry2.CompletionTokens)
	}
	if entry2.PromptTokens != 0 {
		t.Errorf("estimate: PromptTokens = %d, want 0", entry2.PromptTokens)
	}
	if !strings.Contains(entry2.Error, "usage estimated") {
		t.Errorf("estimate: Error = %q, want it to note the estimate", entry2.Error)
	}

	// usage == nil, chars == 0 → no change at all.
	entry3 := SpendEntry{}
	srv.recordStreamUsage(&entry3, nil, 0)
	if entry3.CompletionTokens != 0 || entry3.PromptTokens != 0 || entry3.Error != "" {
		t.Errorf("no data: entry mutated = %+v", entry3)
	}
}

// ── usageCost + finalizeCost ────────────────────────────────────────────────

func TestCovRenUsageCostPricesViaDeployment(t *testing.T) {
	srv := covRenPricingServer(t)
	usage := &api.Usage{PromptTokens: 1000, CompletionTokens: 1000}

	got := srv.usageCost("claude-sonnet-4-5", usage)
	deploymentPrice := costs.Cost("openai/gpt-4o", usage)
	aliasPrice := costs.Cost("claude-sonnet-4-5", usage)

	if deploymentPrice <= 0 || aliasPrice <= 0 {
		t.Fatalf("test premise broken: deployment=%v alias=%v (both must be priceable and distinct)", deploymentPrice, aliasPrice)
	}
	if covRenApproxEq(deploymentPrice, aliasPrice) {
		t.Fatalf("test premise broken: deployment and alias price identically (%v); cannot distinguish", deploymentPrice)
	}
	// Must price via the deployment model, not the alias.
	if !covRenApproxEq(got, deploymentPrice) {
		t.Errorf("usageCost = %v, want deployment price %v (alias price %v)", got, deploymentPrice, aliasPrice)
	}
}

func TestCovRenFinalizeCost(t *testing.T) {
	srv := covRenPricingServer(t)

	// No-op when both token counts are zero: Cost is left untouched.
	entry := SpendEntry{ModelAlias: "claude-sonnet-4-5", Cost: 99.0}
	srv.finalizeCost(&entry)
	if entry.Cost != 99.0 {
		t.Errorf("finalizeCost mutated Cost on zero tokens = %v, want 99.0", entry.Cost)
	}

	// With tokens, Cost is priced via the deployment (openai/gpt-4o).
	entry2 := SpendEntry{ModelAlias: "claude-sonnet-4-5", PromptTokens: 1000, CompletionTokens: 1000}
	srv.finalizeCost(&entry2)
	want := costs.Cost("openai/gpt-4o", &api.Usage{PromptTokens: 1000, CompletionTokens: 1000})
	if want <= 0 {
		t.Fatal("test premise broken: openai/gpt-4o priced to 0")
	}
	if !covRenApproxEq(entry2.Cost, want) {
		t.Errorf("finalizeCost Cost = %v, want %v", entry2.Cost, want)
	}
}

// Guard: covRenPricingServer built a usable server (surfaces config breakage
// distinctly from the pricing assertions).
func TestCovRenPricingServerBuilds(t *testing.T) {
	srv := covRenPricingServer(t)
	if srv == nil {
		t.Fatal("nil server")
	}
	if _, ok := srv.aliasEntries["claude-sonnet-4-5"]; !ok {
		t.Error("alias claude-sonnet-4-5 not indexed")
	}
}
