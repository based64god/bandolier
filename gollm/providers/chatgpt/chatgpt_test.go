package chatgpt

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

// fakeJWT builds an unsigned JWT with the given claims.
func fakeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	seg := func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
	return seg([]byte(`{"alg":"none"}`)) + "." + seg(payload) + ".sig"
}

// liveToken returns a JWT valid for an hour carrying the account-id claim.
func liveToken(t *testing.T) string {
	return fakeJWT(t, map[string]any{
		"exp":                         time.Now().Add(time.Hour).Unix(),
		"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct-123"},
	})
}

func expiredToken(t *testing.T) string {
	return fakeJWT(t, map[string]any{"exp": time.Now().Add(-time.Hour).Unix()})
}

// codexAuthJSON renders the Codex CLI's auth.json shape.
func codexAuthJSON(access, refresh string) string {
	b, _ := json.Marshal(map[string]any{
		"OPENAI_API_KEY": nil,
		"tokens": map[string]string{
			"access_token":  access,
			"refresh_token": refresh,
			"id_token":      access,
		},
		"last_refresh": "2026-01-01T00:00:00Z",
	})
	return string(b)
}

// sseBody renders chat-completion chunks as an SSE stream.
func sseBody(chunks ...string) string {
	out := ""
	for _, c := range chunks {
		out += "data: " + c + "\n\n"
	}
	return out + "data: [DONE]\n\n"
}

// newTestProvider builds a Provider aimed at a fake backend, with credentials
// injected via CHATGPT_AUTH_JSON.
func newTestProvider(t *testing.T, backendURL, authJSON string) *Provider {
	t.Helper()
	t.Setenv("CHATGPT_AUTH_JSON", authJSON)
	t.Setenv("CODEX_AUTH_JSON", "")
	t.Setenv("CHATGPT_AUTH_FILE", "")
	p, err := api.NewProvider("chatgpt", api.ProviderConfig{BaseURL: backendURL})
	if err != nil {
		t.Fatal(err)
	}
	return p.(*Provider)
}

func TestStreamSendsBackendHeadersAndStripsLimits(t *testing.T) {
	access := liveToken(t)
	var got struct {
		auth, account, originator, session string
		body                               map[string]any
	}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %s, want /chat/completions", r.URL.Path)
		}
		got.auth = r.Header.Get("Authorization")
		got.account = r.Header.Get("ChatGPT-Account-Id")
		got.originator = r.Header.Get("originator")
		got.session = r.Header.Get("session_id")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got.body)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseBody(`{"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}`))
	}))
	defer backend.Close()

	p := newTestProvider(t, backend.URL, codexAuthJSON(access, "refresh-1"))
	maxTok := 128
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:     "gpt-5.5",
		Messages:  []api.Message{{Role: "user", Content: api.TextContent("hello")}},
		MaxTokens: &maxTok,
		BaseURL:   backend.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	for {
		if _, err := stream.Recv(); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
	}

	if got.auth != "Bearer "+access {
		t.Errorf("Authorization = %q, want the access token", got.auth)
	}
	if got.account != "acct-123" {
		t.Errorf("ChatGPT-Account-Id = %q, want acct-123 (from the JWT claim)", got.account)
	}
	if got.originator != "codex_cli_rs" {
		t.Errorf("originator = %q", got.originator)
	}
	if got.session == "" {
		t.Error("session_id header missing")
	}
	if _, present := got.body["max_tokens"]; present {
		t.Error("max_tokens was not stripped for the subscription backend")
	}
	if _, present := got.body["stream_options"]; present {
		t.Error("stream_options was not stripped for the subscription backend")
	}
}

func TestExpiredTokenRefreshesAndPersists(t *testing.T) {
	fresh := liveToken(t)
	var refreshCalls int
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshCalls++
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["grant_type"] != "refresh_token" || body["refresh_token"] != "refresh-1" || body["client_id"] != oauthClientID {
			t.Errorf("unexpected refresh body: %v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"access_token":  fresh,
			"refresh_token": "refresh-2",
			"id_token":      fresh,
		})
	}))
	defer oauth.Close()

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+fresh {
			t.Errorf("Authorization = %q, want the refreshed token", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseBody(`{"id":"c1","choices":[{"index":0,"delta":{"content":"ok"}}]}`))
	}))
	defer backend.Close()

	// File-backed credentials in the Codex CLI shape, holding an expired token.
	authPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(authPath, []byte(codexAuthJSON(expiredToken(t), "refresh-1")), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHATGPT_AUTH_JSON", "")
	t.Setenv("CODEX_AUTH_JSON", "")
	t.Setenv("CHATGPT_AUTH_FILE", authPath)
	pv, err := api.NewProvider("chatgpt", api.ProviderConfig{BaseURL: backend.URL})
	if err != nil {
		t.Fatal(err)
	}
	p := pv.(*Provider)
	p.auth.tokenURL = oauth.URL

	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "gpt-5.5",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
		BaseURL:  backend.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "ok" {
		t.Errorf("content = %q, want ok", got)
	}
	if refreshCalls != 1 {
		t.Errorf("refresh calls = %d, want 1", refreshCalls)
	}

	// The rotated refresh token must be persisted, in the Codex shape.
	raw, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}
	var persisted authFile
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Tokens == nil || persisted.Tokens.RefreshToken != "refresh-2" {
		t.Errorf("persisted auth.json = %s, want rotated refresh token under tokens.*", raw)
	}
}

func TestFlatAuthShapeAccepted(t *testing.T) {
	flat, _ := json.Marshal(map[string]string{
		"access_token":  liveToken(t),
		"refresh_token": "r",
		"account_id":    "acct-flat",
	})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("ChatGPT-Account-Id"); got != "acct-flat" {
			t.Errorf("ChatGPT-Account-Id = %q, want acct-flat (explicit account_id wins)", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseBody(`{"id":"c1","choices":[{"index":0,"delta":{"content":"ok"}}]}`))
	}))
	defer backend.Close()

	p := newTestProvider(t, backend.URL, string(flat))
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "gpt-5.5",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		BaseURL:  backend.URL,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMissingCredentialsIsAuthError(t *testing.T) {
	t.Setenv("CHATGPT_AUTH_JSON", "")
	t.Setenv("CODEX_AUTH_JSON", "")
	t.Setenv("CHATGPT_AUTH_FILE", filepath.Join(t.TempDir(), "missing.json"))
	pv, err := api.NewProvider("chatgpt", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = pv.Stream(context.Background(), &api.ChatRequest{
		Model:    "gpt-5.5",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	var apiErr *api.Error
	if !asAPIError(err, &apiErr) || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("err = %v, want an authentication api.Error", err)
	}
}

// asAPIError unwraps err into *api.Error.
func asAPIError(err error, target **api.Error) bool {
	e, ok := err.(*api.Error)
	if ok {
		*target = e
	}
	return ok
}

// TestToolCallStreamNormalization feeds the backend's broken shape — two
// parallel calls both streamed at index 0, each followed by a redundant
// closing chunk repeating id+name — and asserts the accumulated result has
// two distinct, correctly-argumented calls.
func TestToolCallStreamNormalization(t *testing.T) {
	chunks := []string{
		`{"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read","arguments":""}}]}}]}`,
		`{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\"a\"}"}}]}}]}`,
		`{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read","arguments":""}}]}}]}`,
		`{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"write","arguments":""}}]}}]}`,
		`{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\"b\"}"}}]}}]}`,
		`{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"write","arguments":""}}]}}]}`,
		`{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
	}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseBody(chunks...))
	}))
	defer backend.Close()

	p := newTestProvider(t, backend.URL, codexAuthJSON(liveToken(t), "r"))
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "gpt-5.5",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("go")}},
		BaseURL:  backend.URL,
	})
	if err != nil {
		t.Fatal(err)
	}

	calls := resp.Choices[0].Message.ToolCalls
	if len(calls) != 2 {
		t.Fatalf("tool calls = %d (%+v), want 2", len(calls), calls)
	}
	if calls[0].ID != "call_a" || calls[0].Function.Name != "read" || calls[0].Function.Arguments != `{"path":"a"}` {
		t.Errorf("call 0 = %+v", calls[0])
	}
	if calls[1].ID != "call_b" || calls[1].Function.Name != "write" || calls[1].Function.Arguments != `{"path":"b"}` {
		t.Errorf("call 1 = %+v", calls[1])
	}
}
