package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/based64god/gollm"
	"github.com/based64god/gollm/api"
)

// ── stub provider (tests only) ──────────────────────────────────────────────
//
// A pure in-memory provider registered as "stub". Behavior is keyed by
// req.APIKey, so each deployment in a test acts independently: give every
// deployment a unique APIKey and register a stubRoute under it.

type stubRoute struct {
	mu     sync.Mutex
	calls  int
	models []string // provider-local model of each call, in order

	complete func(call int, req *api.ChatRequest) (*api.ChatResponse, error)
	stream   func(call int, req *api.ChatRequest) (api.ChatStream, error)
	embed    func(call int, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error)
}

func (rt *stubRoute) count() int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.calls
}

func (rt *stubRoute) record(model string) int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.calls++
	rt.models = append(rt.models, model)
	return rt.calls
}

var (
	stubMu     sync.Mutex
	stubRoutes = map[string]*stubRoute{}
)

func registerRoute(t *testing.T, key string, rt *stubRoute) {
	t.Helper()
	stubMu.Lock()
	stubRoutes[key] = rt
	stubMu.Unlock()
	t.Cleanup(func() {
		stubMu.Lock()
		delete(stubRoutes, key)
		stubMu.Unlock()
	})
}

func lookupRoute(key string) *stubRoute {
	stubMu.Lock()
	defer stubMu.Unlock()
	return stubRoutes[key]
}

type stubProvider struct{}

func (stubProvider) Name() string { return "stub" }

func (stubProvider) Complete(_ context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	rt := lookupRoute(req.APIKey)
	if rt == nil || rt.complete == nil {
		return nil, fmt.Errorf("stub: no complete route for key %q", req.APIKey)
	}
	return rt.complete(rt.record(req.Model), req)
}

func (stubProvider) Stream(_ context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	rt := lookupRoute(req.APIKey)
	if rt == nil || rt.stream == nil {
		return nil, fmt.Errorf("stub: no stream route for key %q", req.APIKey)
	}
	return rt.stream(rt.record(req.Model), req)
}

func (stubProvider) Embed(_ context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	rt := lookupRoute(req.APIKey)
	if rt == nil || rt.embed == nil {
		return nil, fmt.Errorf("stub: no embed route for key %q", req.APIKey)
	}
	return rt.embed(rt.record(req.Model), req)
}

func init() {
	api.Register("stub", func(api.ProviderConfig) (api.Provider, error) { return stubProvider{}, nil })
}

// ── helpers ─────────────────────────────────────────────────────────────────

func okResp(model string) *api.ChatResponse {
	return &api.ChatResponse{
		ID: "resp-1", Object: "chat.completion", Model: model,
		Choices: []api.Choice{{
			Message:      api.Message{Role: "assistant", Content: api.TextContent("ok:" + model)},
			FinishReason: "stop",
		}},
		Usage: &api.Usage{PromptTokens: 3, CompletionTokens: 4, TotalTokens: 7},
	}
}

func alwaysOK() *stubRoute {
	return &stubRoute{complete: func(_ int, req *api.ChatRequest) (*api.ChatResponse, error) {
		return okResp(req.Model), nil
	}}
}

func alwaysErr(e *api.Error) *stubRoute {
	return &stubRoute{complete: func(int, *api.ChatRequest) (*api.ChatResponse, error) {
		return nil, e
	}}
}

func err500() *api.Error {
	return &api.Error{Type: api.ErrInternalServer, StatusCode: 500, Message: "boom"}
}

func chatReq(alias string) *api.ChatRequest {
	return &api.ChatRequest{
		Model:    alias,
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}
}

// dep builds a stub-backed deployment whose behavior key is its APIKey.
func dep(id, alias, key string) Deployment {
	return Deployment{
		ID:        id,
		ModelName: alias,
		Params:    DeploymentParams{Model: "stub/m-" + id, APIKey: key},
	}
}

func mustRouter(t *testing.T, cfg Config) *Router {
	t.Helper()
	r, err := New(gollm.New(), cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r
}

func assertInFlightZero(t *testing.T, r *Router) {
	t.Helper()
	for _, d := range r.deployments {
		if n := d.inFlight.Load(); n != 0 {
			t.Errorf("deployment %s in-flight = %d, want 0", d.ID, n)
		}
	}
}

// ── construction and resolution ─────────────────────────────────────────────

func TestNewValidation(t *testing.T) {
	if _, err := New(nil, Config{}); err == nil {
		t.Error("no deployments: want error")
	}
	if _, err := New(nil, Config{Deployments: []Deployment{
		dep("same", "a", "k1"), dep("same", "a", "k2"),
	}}); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Errorf("duplicate IDs: want duplicate error, got %v", err)
	}
	if _, err := New(nil, Config{
		Deployments: []Deployment{dep("d", "a", "k")},
		Strategy:    "psychic",
	}); err == nil || !strings.Contains(err.Error(), "psychic") {
		t.Errorf("unknown strategy: want error naming it, got %v", err)
	}

	// Empty IDs are assigned "<ModelName>-<i>" by position.
	r := mustRouter(t, Config{Deployments: []Deployment{
		{ModelName: "a", Params: DeploymentParams{Model: "stub/x"}},
		{ModelName: "a", Params: DeploymentParams{Model: "stub/y"}},
	}})
	if got := []string{r.deployments[0].ID, r.deployments[1].ID}; !reflect.DeepEqual(got, []string{"a-0", "a-1"}) {
		t.Errorf("assigned IDs = %v", got)
	}
}

func TestModelNamesAndHasModel(t *testing.T) {
	r := mustRouter(t, Config{Deployments: []Deployment{
		dep("b1", "beta", "k1"),
		dep("a1", "alpha", "k2"),
		dep("a2", "alpha", "k3"),
		dep("w", "claude-*", "k4"),
	}})
	if got := r.ModelNames(); !reflect.DeepEqual(got, []string{"alpha", "beta", "claude-*"}) {
		t.Errorf("ModelNames = %v", got)
	}
	for alias, want := range map[string]bool{
		"alpha": true, "beta": true, "claude-*": true,
		"claude-sonnet-4-5": true, "gpt-4o": false, "claud": false,
	} {
		if got := r.HasModel(alias); got != want {
			t.Errorf("HasModel(%q) = %v, want %v", alias, got, want)
		}
	}
}

func TestUnknownAliasNotFound(t *testing.T) {
	registerRoute(t, "k-known", alwaysOK())
	r := mustRouter(t, Config{Deployments: []Deployment{dep("d", "known-model", "k-known")}})

	_, err := r.Completion(context.Background(), chatReq("nope"))
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrNotFound || apiErr.StatusCode != 404 {
		t.Fatalf("want *api.Error not_found 404, got %v", err)
	}
	if !strings.Contains(apiErr.Message, "known-model") {
		t.Errorf("message should list known aliases, got %q", apiErr.Message)
	}
}

// ── outbound translation through a real provider + httptest ────────────────

func TestCompletionAppliesDeploymentParams(t *testing.T) {
	var (
		gotAuth, gotHeader string
		gotBody            struct {
			Model string `json:"model"`
		}
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotHeader = r.Header.Get("X-Route")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &gotBody); err != nil {
			t.Errorf("decode outbound body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"x","object":"chat.completion","model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer srv.Close()

	r := mustRouter(t, Config{Deployments: []Deployment{{
		ID:        "oai",
		ModelName: "prod",
		Params: DeploymentParams{
			Model:   "openai/gpt-4o",
			APIKey:  "test-key",
			BaseURL: srv.URL,
			Headers: map[string]string{"X-Route": "primary"},
		},
	}}})

	resp, err := r.Completion(context.Background(), chatReq("prod"))
	if err != nil {
		t.Fatalf("Completion: %v", err)
	}
	if gotAuth != "Bearer test-key" {
		t.Errorf("Authorization = %q, want deployment key", gotAuth)
	}
	if gotHeader != "primary" {
		t.Errorf("X-Route = %q, want deployment header", gotHeader)
	}
	if gotBody.Model != "gpt-4o" {
		t.Errorf("wire model = %q, want provider-local %q", gotBody.Model, "gpt-4o")
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hello" {
		t.Errorf("content = %q", got)
	}
	assertInFlightZero(t, r)
}

func TestStreamEndToEndHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, data := range []string{
			`{"id":"s1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}`,
			`{"id":"s1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}`,
			`[DONE]`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", data)
		}
	}))
	defer srv.Close()

	r := mustRouter(t, Config{Deployments: []Deployment{{
		ID:        "oai",
		ModelName: "prod",
		Params:    DeploymentParams{Model: "openai/gpt-4o", APIKey: "test-key", BaseURL: srv.URL},
	}}})

	stream, err := r.Stream(context.Background(), chatReq("prod"))
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
	if got := acc.Response().Choices[0].Message.Content.AsText(); got != "hello world" {
		t.Errorf("accumulated = %q", got)
	}
	assertInFlightZero(t, r)
	if _, ok := r.deployments[0].latency(); !ok {
		t.Error("stream completion should record latency")
	}
}

func TestErrorMappingThroughHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":{"message":"bad key","type":"invalid_request_error"}}`)
	}))
	defer srv.Close()

	r := mustRouter(t, Config{Deployments: []Deployment{{
		ID:        "oai",
		ModelName: "prod",
		Params:    DeploymentParams{Model: "openai/gpt-4o", APIKey: "bad", BaseURL: srv.URL},
	}}})

	_, err := r.Completion(context.Background(), chatReq("prod"))
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("want classified auth error, got %v", err)
	}
	// Auth failure cools the deployment down immediately.
	if !r.deployments[0].cooling(time.Now()) {
		t.Error("deployment should be cooling after auth failure")
	}
}

// ── retries, cooldowns, failure accounting ──────────────────────────────────

func TestRetryHonorsRetryAfter(t *testing.T) {
	const retryAfter = 150 * time.Millisecond
	rt := &stubRoute{complete: func(call int, req *api.ChatRequest) (*api.ChatResponse, error) {
		if call == 1 {
			return nil, &api.Error{Type: api.ErrRateLimit, StatusCode: 429, RetryAfter: retryAfter}
		}
		return okResp(req.Model), nil
	}}
	registerRoute(t, "k-ra", rt)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("d", "m", "k-ra")},
		NumRetries:  1,
		BackoffBase: time.Millisecond, // RetryAfter must dominate
	})

	start := time.Now()
	if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
		t.Fatalf("Completion: %v", err)
	}
	if elapsed := time.Since(start); elapsed < retryAfter {
		t.Errorf("elapsed %v < RetryAfter %v: backoff did not honor Retry-After", elapsed, retryAfter)
	}
	if rt.count() != 2 {
		t.Errorf("calls = %d, want 2 (1 + 1 retry on same deployment)", rt.count())
	}
}

func TestNonRetryableSkipsSameDeploymentRetry(t *testing.T) {
	rtA := alwaysErr(&api.Error{Type: api.ErrBadRequest, StatusCode: 400, Message: "bad"})
	rtB := alwaysOK()
	registerRoute(t, "k-nrA", rtA)
	registerRoute(t, "k-nrB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "m", "k-nrA"), dep("b", "m", "k-nrB")},
		Strategy:    StrategyRoundRobin,
		NumRetries:  3,
		BackoffBase: time.Millisecond,
	})

	if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
		t.Fatalf("Completion: %v", err)
	}
	if rtA.count() != 1 {
		t.Errorf("non-retryable error retried same deployment: calls = %d, want 1", rtA.count())
	}
	if rtB.count() != 1 {
		t.Errorf("next deployment not tried: calls = %d, want 1", rtB.count())
	}
}

func TestFailoverPeersGetSingleAttempt(t *testing.T) {
	// The strategy's first pick gets NumRetries same-deployment retries;
	// failover peers are each tried once more with no per-deployment re-retry.
	rtA := alwaysErr(err500())
	rtB := alwaysErr(err500())
	registerRoute(t, "k-foA", rtA)
	registerRoute(t, "k-foB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "m", "k-foA"), dep("b", "m", "k-foB")},
		Strategy:    StrategyRoundRobin,
		NumRetries:  2,
		BackoffBase: time.Millisecond,
	})

	if _, err := r.Completion(context.Background(), chatReq("m")); err == nil {
		t.Fatal("want error when every deployment fails")
	}
	if rtA.count() != 3 {
		t.Errorf("first pick calls = %d, want 3 (initial + NumRetries=2)", rtA.count())
	}
	if rtB.count() != 1 {
		t.Errorf("failover peer calls = %d, want 1 (no per-deployment re-retry)", rtB.count())
	}
}

func TestCooldownAfterAllowedFails(t *testing.T) {
	rtA := alwaysErr(err500())
	rtB := alwaysOK()
	registerRoute(t, "k-cdA", rtA)
	registerRoute(t, "k-cdB", rtB)
	r := mustRouter(t, Config{
		Deployments:  []Deployment{dep("a", "m", "k-cdA"), dep("b", "m", "k-cdB")},
		Strategy:     StrategyRoundRobin,
		AllowedFails: 1,
		CooldownTime: 300 * time.Millisecond,
	})

	// Round-robin picks A first. Failure 1 (≤ AllowedFails) leaves A healthy;
	// failure 2 (> AllowedFails) starts the cooldown. Every request still
	// succeeds via B.
	for i := 0; i < 10; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if rtA.count() != 2 {
		t.Errorf("A calls = %d, want exactly 2 (then cooled down)", rtA.count())
	}
	if rtB.count() != 10 {
		t.Errorf("B calls = %d, want 10", rtB.count())
	}

	// Cooldown expiry re-admits A.
	time.Sleep(400 * time.Millisecond)
	if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
		t.Fatalf("post-cooldown request: %v", err)
	}
	if rtA.count() != 3 {
		t.Errorf("A calls after cooldown expiry = %d, want 3", rtA.count())
	}
}

func TestAuthErrorCoolsDownImmediately(t *testing.T) {
	rtA := alwaysErr(&api.Error{Type: api.ErrAuthentication, StatusCode: 401, Message: "bad key"})
	rtB := alwaysOK()
	registerRoute(t, "k-auA", rtA)
	registerRoute(t, "k-auB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "m", "k-auA"), dep("b", "m", "k-auB")},
		Strategy:    StrategyRoundRobin,
		// AllowedFails defaults to 3; auth must not need that many.
	})

	for i := 0; i < 5; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if rtA.count() != 1 {
		t.Errorf("A calls = %d, want 1 (immediate cooldown on auth failure)", rtA.count())
	}
	if rtB.count() != 5 {
		t.Errorf("B calls = %d, want 5", rtB.count())
	}
}

func TestFailOpenWhenAllCooling(t *testing.T) {
	// Single deployment: fails until cooled, but requests keep reaching it
	// (fail-open) because there is no healthy peer.
	calls := 0
	rt := &stubRoute{complete: func(call int, req *api.ChatRequest) (*api.ChatResponse, error) {
		calls = call
		if call <= 2 {
			return nil, err500()
		}
		return okResp(req.Model), nil
	}}
	registerRoute(t, "k-fo", rt)
	r := mustRouter(t, Config{
		Deployments:  []Deployment{dep("only", "m", "k-fo")},
		AllowedFails: 1,
		CooldownTime: time.Hour, // never expires within the test
	})

	for i := 0; i < 2; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err == nil {
			t.Fatalf("request %d should fail", i)
		}
	}
	if !r.deployments[0].cooling(time.Now()) {
		t.Fatal("deployment should be cooling")
	}
	if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
		t.Fatalf("fail-open request should reach the cooled deployment: %v", err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
}

// ── fallbacks ───────────────────────────────────────────────────────────────

func TestFallbackOn500s(t *testing.T) {
	rtA := alwaysErr(err500())
	rtB := alwaysOK()
	registerRoute(t, "k-fbA", rtA)
	registerRoute(t, "k-fbB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "prod", "k-fbA"), dep("b", "backup", "k-fbB")},
		Fallbacks:   map[string][]string{"prod": {"backup"}},
		NumRetries:  1,
		BackoffBase: time.Millisecond,
	})

	resp, err := r.Completion(context.Background(), chatReq("prod"))
	if err != nil {
		t.Fatalf("Completion: %v", err)
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "ok:m-b" {
		t.Errorf("response = %q, want the fallback deployment's", got)
	}
	if rtA.count() != 2 {
		t.Errorf("A calls = %d, want 2 (initial + NumRetries=1, retryable 500)", rtA.count())
	}
}

func TestAllFallbacksFailReturnsLastErrorWrapped(t *testing.T) {
	rtA := alwaysErr(err500())
	rtB := alwaysErr(&api.Error{Type: api.ErrUnavailable, StatusCode: 503, Message: "backup down"})
	registerRoute(t, "k-lwA", rtA)
	registerRoute(t, "k-lwB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "prod", "k-lwA"), dep("b", "backup", "k-lwB")},
		Fallbacks:   map[string][]string{"prod": {"backup"}},
	})

	_, err := r.Completion(context.Background(), chatReq("prod"))
	if err == nil {
		t.Fatal("want error")
	}
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Message != "backup down" {
		t.Errorf("want LAST error (backup's) in the chain, got %v", err)
	}
	if !strings.Contains(err.Error(), "backup") || !strings.Contains(err.Error(), "prod") {
		t.Errorf("wrapped message should note fallbacks tried, got %q", err)
	}
}

func TestContextWindowFallbackConsultedFirst(t *testing.T) {
	rtSmall := alwaysErr(&api.Error{Type: api.ErrContextWindow, StatusCode: 400, Message: "prompt is too long"})
	rtBig := alwaysOK()
	rtGeneric := alwaysOK()
	registerRoute(t, "k-cwS", rtSmall)
	registerRoute(t, "k-cwB", rtBig)
	registerRoute(t, "k-cwG", rtGeneric)
	r := mustRouter(t, Config{
		Deployments: []Deployment{
			dep("s", "small", "k-cwS"), dep("b", "big", "k-cwB"), dep("g", "generic", "k-cwG"),
		},
		ContextWindowFallbacks: map[string][]string{"small": {"big"}},
		Fallbacks:              map[string][]string{"small": {"generic"}},
	})

	resp, err := r.Completion(context.Background(), chatReq("small"))
	if err != nil {
		t.Fatalf("Completion: %v", err)
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "ok:m-b" {
		t.Errorf("response = %q, want the context-window fallback's", got)
	}
	if rtGeneric.count() != 0 {
		t.Errorf("generic fallback called %d times; context-window chain should win", rtGeneric.count())
	}

	// A non-context-window failure must use the generic chain only.
	rtSmall2 := alwaysErr(err500())
	rtBig2 := alwaysOK()
	rtGeneric2 := alwaysOK()
	registerRoute(t, "k-cwS2", rtSmall2)
	registerRoute(t, "k-cwB2", rtBig2)
	registerRoute(t, "k-cwG2", rtGeneric2)
	r2 := mustRouter(t, Config{
		Deployments: []Deployment{
			dep("s", "small", "k-cwS2"), dep("b", "big", "k-cwB2"), dep("g", "generic", "k-cwG2"),
		},
		ContextWindowFallbacks: map[string][]string{"small": {"big"}},
		Fallbacks:              map[string][]string{"small": {"generic"}},
	})
	if _, err := r2.Completion(context.Background(), chatReq("small")); err != nil {
		t.Fatalf("Completion: %v", err)
	}
	if rtBig2.count() != 0 {
		t.Errorf("big called %d times on a 500; only the generic chain should run", rtBig2.count())
	}
	if rtGeneric2.count() != 1 {
		t.Errorf("generic calls = %d, want 1", rtGeneric2.count())
	}
}

// ── wildcard aliases ────────────────────────────────────────────────────────

func TestWildcardAliasAndModelSubstitution(t *testing.T) {
	rtW := alwaysOK()
	rtExact := alwaysOK()
	registerRoute(t, "k-wc", rtW)
	registerRoute(t, "k-ex", rtExact)
	r := mustRouter(t, Config{Deployments: []Deployment{
		{ID: "wild", ModelName: "claude-*", Params: DeploymentParams{Model: "stub/*", APIKey: "k-wc"}},
		{ID: "exact", ModelName: "claude-fixed", Params: DeploymentParams{Model: "stub/pinned", APIKey: "k-ex"}},
	}})

	// Wildcard passthrough: the requested alias replaces the "*" in
	// Params.Model, and the provider sees it with the prefix stripped.
	if _, err := r.Completion(context.Background(), chatReq("claude-sonnet-4-5")); err != nil {
		t.Fatalf("wildcard Completion: %v", err)
	}
	rtW.mu.Lock()
	gotModel := rtW.models[0]
	rtW.mu.Unlock()
	if gotModel != "claude-sonnet-4-5" {
		t.Errorf("wildcard deployment saw model %q, want %q", gotModel, "claude-sonnet-4-5")
	}

	// Exact ModelName match wins over an overlapping wildcard.
	if _, err := r.Completion(context.Background(), chatReq("claude-fixed")); err != nil {
		t.Fatalf("exact Completion: %v", err)
	}
	if rtExact.count() != 1 || rtW.count() != 1 {
		t.Errorf("exact/wildcard calls = %d/%d, want 1/1", rtExact.count(), rtW.count())
	}
	rtExact.mu.Lock()
	pinned := rtExact.models[0]
	rtExact.mu.Unlock()
	if pinned != "pinned" {
		t.Errorf("exact deployment saw model %q, want %q", pinned, "pinned")
	}
}

func TestWildcardCapturedSegmentSubstitution(t *testing.T) {
	// litellm PatternMatchRouter.set_deployment_model_name semantics: a
	// provider-passthrough Params.Model ("openai/*") takes the whole requested
	// alias; a patterned Params.Model ("bedrock/anthropic.*") takes only the
	// segment the ModelName wildcard captured; an exact ModelName substitutes
	// the whole alias.
	cases := []struct {
		name, modelName, paramsModel, alias, want string
	}{
		{"passthrough openai", "claude-*", "openai/*", "claude-3-5-sonnet", "openai/claude-3-5-sonnet"},
		{"passthrough azure", "gpt-*", "azure/*", "gpt-4o", "azure/gpt-4o"},
		{"bare star passthrough", "gpt-*", "*", "gpt-4o", "gpt-4o"},
		{"patterned model captures segment", "claude-*", "bedrock/anthropic.*", "claude-3-5-sonnet", "bedrock/anthropic.3-5-sonnet"},
		{"exact alias, passthrough", "gpt-4o", "azure/*", "gpt-4o", "azure/gpt-4o"},
		{"exact alias, patterned model", "prod", "bedrock/anthropic.*", "prod", "bedrock/anthropic.prod"},
		{"no star in params", "claude-*", "anthropic/pinned", "claude-x", "anthropic/pinned"},
	}
	for _, tc := range cases {
		d := &deployment{Deployment: Deployment{
			ModelName: tc.modelName,
			Params:    DeploymentParams{Model: tc.paramsModel},
		}}
		if got := resolvedModel(d, tc.alias); got != tc.want {
			t.Errorf("%s: resolvedModel(ModelName %q, Params.Model %q, alias %q) = %q, want %q",
				tc.name, tc.modelName, tc.paramsModel, tc.alias, got, tc.want)
		}
	}

	// End to end: the provider must see the captured-segment substitution,
	// not the whole alias appended.
	rt := alwaysOK()
	registerRoute(t, "k-cap", rt)
	r := mustRouter(t, Config{Deployments: []Deployment{
		{ID: "br", ModelName: "claude-*", Params: DeploymentParams{Model: "stub/anthropic.*", APIKey: "k-cap"}},
	}})
	if _, err := r.Completion(context.Background(), chatReq("claude-3-5-sonnet")); err != nil {
		t.Fatalf("Completion: %v", err)
	}
	rt.mu.Lock()
	got := rt.models[0]
	rt.mu.Unlock()
	if got != "anthropic.3-5-sonnet" {
		t.Errorf("patterned wildcard deployment saw model %q, want %q", got, "anthropic.3-5-sonnet")
	}
}

// ── strategies ──────────────────────────────────────────────────────────────

func TestRoundRobinDistribution(t *testing.T) {
	rtA := alwaysOK()
	rtB := alwaysOK()
	registerRoute(t, "k-rrA", rtA)
	registerRoute(t, "k-rrB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "m", "k-rrA"), dep("b", "m", "k-rrB")},
		Strategy:    StrategyRoundRobin,
	})

	for i := 0; i < 10; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if rtA.count() != 5 || rtB.count() != 5 {
		t.Errorf("distribution = %d/%d, want 5/5", rtA.count(), rtB.count())
	}
}

func TestWeightedShuffleDistribution(t *testing.T) {
	rtLight := alwaysOK()
	rtHeavy := alwaysOK()
	registerRoute(t, "k-wsL", rtLight)
	registerRoute(t, "k-wsH", rtHeavy)
	light := dep("light", "m", "k-wsL")
	light.Params.Weight = 1
	heavy := dep("heavy", "m", "k-wsH")
	heavy.Params.Weight = 9
	r := mustRouter(t, Config{Deployments: []Deployment{light, heavy}}) // default simple-shuffle

	const n = 2000
	for i := 0; i < n; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	share := float64(rtHeavy.count()) / n
	// Expected 0.9; ±5σ ≈ ±0.034 at n=2000. Generous bounds avoid flakes.
	if share < 0.85 || share > 0.95 {
		t.Errorf("heavy share = %.3f, want ≈0.9 (weights 9:1)", share)
	}
}

func TestLatencyBasedPrefersFasterDeployment(t *testing.T) {
	rtFast := alwaysOK()
	rtSlow := &stubRoute{complete: func(_ int, req *api.ChatRequest) (*api.ChatResponse, error) {
		time.Sleep(20 * time.Millisecond)
		return okResp(req.Model), nil
	}}
	registerRoute(t, "k-lbF", rtFast)
	registerRoute(t, "k-lbS", rtSlow)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("fast", "m", "k-lbF"), dep("slow", "m", "k-lbS")},
		Strategy:    StrategyLatencyBased,
	})

	// Warm-up: unseen deployments are picked first, so both get measured.
	for i := 0; i < 4; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
			t.Fatalf("warm-up %d: %v", i, err)
		}
	}
	before := rtFast.count()
	for i := 0; i < 10; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if got := rtFast.count() - before; got != 10 {
		t.Errorf("fast deployment served %d/10 after warm-up, want all", got)
	}
}

func TestStrategyLitellmSpellings(t *testing.T) {
	deps := []Deployment{dep("d", "m", "k-alias")}
	for spelling, want := range map[string]reflect.Type{
		"latency-based-routing":  reflect.TypeOf(latencyBased{}),
		"usage-based-routing":    reflect.TypeOf(leastBusy{}),
		"usage-based-routing-v2": reflect.TypeOf(leastBusy{}),
		StrategySimpleShuffle:    reflect.TypeOf(simpleShuffle{}),
		StrategyLeastBusy:        reflect.TypeOf(leastBusy{}),
	} {
		r, err := New(gollm.New(), Config{Deployments: deps, Strategy: spelling})
		if err != nil {
			t.Errorf("Strategy %q rejected: %v", spelling, err)
			continue
		}
		if got := reflect.TypeOf(r.strat); got != want {
			t.Errorf("Strategy %q built %v, want %v", spelling, got, want)
		}
	}

	_, err := New(gollm.New(), Config{Deployments: deps, Strategy: "bogus"})
	if err == nil {
		t.Fatal("unknown strategy: want error")
	}
	for _, accepted := range []string{StrategySimpleShuffle, StrategyRoundRobin, StrategyLeastBusy, StrategyLatencyBased, "usage-based-routing"} {
		if !strings.Contains(err.Error(), accepted) {
			t.Errorf("unknown-strategy error should list %q, got %q", accepted, err)
		}
	}
}

// ── rate limits ─────────────────────────────────────────────────────────────

func TestRPMLimit(t *testing.T) {
	rt := alwaysOK()
	registerRoute(t, "k-rpm", rt)
	d := dep("d", "m", "k-rpm")
	d.Params.RPM = 2
	r := mustRouter(t, Config{Deployments: []Deployment{d}})

	for i := 0; i < 2; i++ {
		if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	_, err := r.Completion(context.Background(), chatReq("m"))
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrRateLimit {
		t.Fatalf("third request: want rate_limit_error, got %v", err)
	}
	if rt.count() != 2 {
		t.Errorf("calls = %d, want 2 (third blocked before dispatch)", rt.count())
	}
}

func TestTPMLimitFromResponseUsage(t *testing.T) {
	rt := &stubRoute{complete: func(_ int, req *api.ChatRequest) (*api.ChatResponse, error) {
		resp := okResp(req.Model)
		resp.Usage = &api.Usage{TotalTokens: 150}
		return resp, nil
	}}
	registerRoute(t, "k-tpm", rt)
	d := dep("d", "m", "k-tpm")
	d.Params.TPM = 100
	r := mustRouter(t, Config{Deployments: []Deployment{d}})

	if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
		t.Fatalf("first request: %v", err)
	}
	_, err := r.Completion(context.Background(), chatReq("m"))
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrRateLimit {
		t.Fatalf("second request: want rate_limit_error after usage 150 > TPM 100, got %v", err)
	}
}

// ── streaming through the router ────────────────────────────────────────────

func chunkOf(content, finish string) *api.ChatChunk {
	return &api.ChatChunk{
		ID: "s", Object: "chat.completion.chunk", Model: "m",
		Choices: []api.ChunkChoice{{Delta: api.Delta{Content: content}, FinishReason: finish}},
	}
}

func TestStreamObtainFailsOver(t *testing.T) {
	rtA := &stubRoute{stream: func(int, *api.ChatRequest) (api.ChatStream, error) {
		return nil, err500()
	}}
	rtB := &stubRoute{stream: func(int, *api.ChatRequest) (api.ChatStream, error) {
		return api.SliceStream([]*api.ChatChunk{chunkOf("hi", ""), chunkOf("!", "stop")}), nil
	}}
	registerRoute(t, "k-sfA", rtA)
	registerRoute(t, "k-sfB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "m", "k-sfA"), dep("b", "m", "k-sfB")},
		Strategy:    StrategyRoundRobin,
	})

	stream, err := r.Stream(context.Background(), chatReq("m"))
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	var content strings.Builder
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		content.WriteString(chunk.Choices[0].Delta.Content)
	}
	stream.Close()
	if content.String() != "hi!" {
		t.Errorf("content = %q", content.String())
	}
	if rtA.count() != 1 || rtB.count() != 1 {
		t.Errorf("calls = %d/%d, want 1/1 (failover to B)", rtA.count(), rtB.count())
	}
	assertInFlightZero(t, r)
}

func TestStreamMidErrorRecordsFailureWithoutReroute(t *testing.T) {
	authErr := &api.Error{Type: api.ErrAuthentication, StatusCode: 401, Message: "expired mid-stream"}
	rtA := &stubRoute{stream: func(int, *api.ChatRequest) (api.ChatStream, error) {
		sent := false
		return api.StreamFunc(func() (*api.ChatChunk, error) {
			if !sent {
				sent = true
				return chunkOf("partial", ""), nil
			}
			return nil, authErr
		}, nil), nil
	}}
	rtB := &stubRoute{stream: func(int, *api.ChatRequest) (api.ChatStream, error) {
		return api.SliceStream([]*api.ChatChunk{chunkOf("other", "stop")}), nil
	}}
	registerRoute(t, "k-smA", rtA)
	registerRoute(t, "k-smB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "m", "k-smA"), dep("b", "m", "k-smB")},
		Strategy:    StrategyRoundRobin,
	})

	stream, err := r.Stream(context.Background(), chatReq("m"))
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("first Recv: %v", err)
	}
	_, err = stream.Recv()
	if !errors.Is(err, error(authErr)) {
		t.Fatalf("mid-stream error must surface unrerouted, got %v", err)
	}
	stream.Close()

	if rtB.count() != 0 {
		t.Errorf("B calls = %d; mid-stream errors must not re-route", rtB.count())
	}
	if !r.deployments[0].cooling(time.Now()) {
		t.Error("mid-stream auth failure should cool the deployment down")
	}
	assertInFlightZero(t, r)
}

// ── embeddings ──────────────────────────────────────────────────────────────

func TestEmbeddingRoutesAndFallsBack(t *testing.T) {
	rtA := &stubRoute{embed: func(int, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
		return nil, err500()
	}}
	rtB := &stubRoute{embed: func(_ int, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
		return &api.EmbeddingResponse{
			Object: "list", Model: req.Model,
			Data:  []api.Embedding{{Object: "embedding", Embedding: []float64{0.1, 0.2}}},
			Usage: &api.Usage{TotalTokens: 3},
		}, nil
	}}
	registerRoute(t, "k-emA", rtA)
	registerRoute(t, "k-emB", rtB)
	r := mustRouter(t, Config{
		Deployments: []Deployment{dep("a", "embed", "k-emA"), dep("b", "embed", "k-emB")},
		Strategy:    StrategyRoundRobin,
	})

	resp, err := r.Embedding(context.Background(), &api.EmbeddingRequest{
		Model: "embed", Input: api.StringOrSlice{"hello"},
	})
	if err != nil {
		t.Fatalf("Embedding: %v", err)
	}
	if len(resp.Data) != 1 || resp.Model != "m-b" {
		t.Errorf("response = %+v, want deployment b's", resp)
	}
	assertInFlightZero(t, r)
}

// ── panic safety ────────────────────────────────────────────────────────────

func TestPanicInAttemptReleasesInFlight(t *testing.T) {
	rt := &stubRoute{complete: func(int, *api.ChatRequest) (*api.ChatResponse, error) {
		panic("adapter bug")
	}}
	registerRoute(t, "k-pan", rt)
	r := mustRouter(t, Config{Deployments: []Deployment{dep("d", "m", "k-pan")}})

	func() {
		defer func() {
			if recover() == nil {
				t.Error("adapter panic should propagate to the caller")
			}
		}()
		_, _ = r.Completion(context.Background(), chatReq("m"))
	}()
	assertInFlightZero(t, r)
}

// ── SelectDeployment (raw passthrough) ──────────────────────────────────────

func TestSelectDeploymentUnknownAlias(t *testing.T) {
	r := mustRouter(t, Config{Deployments: []Deployment{dep("d", "known", "k-sdu")}})
	_, _, err := r.SelectDeployment("nope")
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrNotFound || apiErr.StatusCode != 404 {
		t.Fatalf("want *api.Error not_found 404, got %v", err)
	}
}

func TestSelectDeploymentWildcardReleaseAndCooldown(t *testing.T) {
	r := mustRouter(t, Config{
		Deployments: []Deployment{
			{ID: "a", ModelName: "claude-*", Params: DeploymentParams{Model: "openai/*"}},
			{ID: "b", ModelName: "claude-*", Params: DeploymentParams{Model: "anthropic/*"}},
		},
		Strategy:     StrategyRoundRobin,
		AllowedFails: 1,
		CooldownTime: time.Hour, // never expires within the test
	})
	wantModel := map[string]string{
		"a": "openai/claude-3-5-sonnet",
		"b": "anthropic/claude-3-5-sonnet",
	}

	d, release, err := r.SelectDeployment("claude-3-5-sonnet")
	if err != nil {
		t.Fatalf("SelectDeployment: %v", err)
	}
	if d.Params.Model != wantModel[d.ID] {
		t.Errorf("Params.Model = %q, want %q (wildcard substituted)", d.Params.Model, wantModel[d.ID])
	}
	held := int64(0)
	for _, dp := range r.deployments {
		held += dp.inFlight.Load()
	}
	if held != 1 {
		t.Errorf("in-flight while held = %d, want 1", held)
	}
	release(true, &api.Usage{TotalTokens: 5})
	release(true, nil) // extra release must be a no-op
	assertInFlightZero(t, r)

	// The copy must not alias router state: the pool entry keeps its star.
	for _, dp := range r.deployments {
		if !strings.HasSuffix(dp.Params.Model, "*") {
			t.Errorf("internal deployment %s Params.Model mutated to %q", dp.ID, dp.Params.Model)
		}
	}

	// Cool "a" down: failures must exceed AllowedFails (two with AllowedFails=1).
	fails := 0
	for fails < 2 {
		d, release, err := r.SelectDeployment("claude-3-5-sonnet")
		if err != nil {
			t.Fatalf("SelectDeployment: %v", err)
		}
		if d.ID == "a" {
			release(false, nil)
			fails++
		} else {
			release(true, nil)
		}
	}

	// While the healthy peer exists, the cooled deployment is skipped.
	for i := 0; i < 8; i++ {
		d, release, err := r.SelectDeployment("claude-3-5-sonnet")
		if err != nil {
			t.Fatalf("SelectDeployment %d: %v", i, err)
		}
		if d.ID != "b" {
			t.Errorf("select %d picked %s, want b while a is cooling", i, d.ID)
		}
		release(true, nil)
	}
	assertInFlightZero(t, r)
}

func TestSelectDeploymentHonorsRPM(t *testing.T) {
	d := dep("d", "m", "k-srpm")
	d.Params.RPM = 1
	r := mustRouter(t, Config{Deployments: []Deployment{d}})

	_, release, err := r.SelectDeployment("m")
	if err != nil {
		t.Fatalf("first SelectDeployment: %v", err)
	}
	release(true, nil)

	_, _, err = r.SelectDeployment("m")
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrRateLimit {
		t.Fatalf("second SelectDeployment: want rate_limit_error, got %v", err)
	}
}

// ── concurrency (run with -race) ────────────────────────────────────────────

func TestConcurrentCompletions(t *testing.T) {
	const deployments = 4
	var routes []*stubRoute
	var deps []Deployment
	for i := 0; i < deployments; i++ {
		rt := &stubRoute{complete: func(_ int, req *api.ChatRequest) (*api.ChatResponse, error) {
			time.Sleep(time.Millisecond) // hold in-flight so least-busy spreads
			return okResp(req.Model), nil
		}}
		key := fmt.Sprintf("k-cc%d", i)
		registerRoute(t, key, rt)
		routes = append(routes, rt)
		deps = append(deps, dep(fmt.Sprintf("d%d", i), "m", key))
	}
	r := mustRouter(t, Config{Deployments: deps, Strategy: StrategyLeastBusy})

	const goroutines, perG = 16, 25
	var wg sync.WaitGroup
	errs := make(chan error, goroutines*perG)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				if _, err := r.Completion(context.Background(), chatReq("m")); err != nil {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent completion: %v", err)
	}

	total := 0
	for i, rt := range routes {
		n := rt.count()
		total += n
		if n == 0 {
			t.Errorf("deployment %d never used under least-busy", i)
		}
	}
	if total != goroutines*perG {
		t.Errorf("total calls = %d, want %d", total, goroutines*perG)
	}
	assertInFlightZero(t, r)
}
