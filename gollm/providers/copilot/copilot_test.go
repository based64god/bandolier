package copilot

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

func sse(chunks ...string) string {
	out := ""
	for _, c := range chunks {
		out += "data: " + c + "\n\n"
	}
	return out + "data: [DONE]\n\n"
}

func TestCopilotTokenExchangeAndChat(t *testing.T) {
	var exchangeCalls int
	var exchangeAuth string
	chat := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer copilot-session-tok" {
			t.Errorf("Authorization = %q, want the session token", got)
		}
		if got := r.Header.Get("copilot-integration-id"); got != "vscode-chat" {
			t.Errorf("copilot-integration-id = %q", got)
		}
		if got := r.Header.Get("editor-version"); got == "" {
			t.Error("editor-version header missing")
		}
		if got := r.Header.Get("X-Initiator"); got != "user" {
			t.Errorf("X-Initiator = %q, want user (last message is a user turn)", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sse(`{"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}`))
	}))
	defer chat.Close()

	exchange := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exchangeCalls++
		exchangeAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":      "copilot-session-tok",
			"expires_at": time.Now().Add(time.Hour).Unix(),
			// The exchange names the account's API endpoint; chat must use it.
			"endpoints": map[string]string{"api": chat.URL},
		})
	}))
	defer exchange.Close()

	t.Setenv("GITHUB_COPILOT_ACCESS_TOKEN", "gh-oauth-tok")
	pv, err := api.NewProvider("github_copilot", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	p := pv.(*Provider)
	p.auth.exchangeURL = exchange.URL

	run := func() {
		stream, err := p.Stream(context.Background(), &api.ChatRequest{
			Model:    "gpt-4.1",
			Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
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
	}
	run()
	run() // second call must reuse the cached session token

	if exchangeAuth != "token gh-oauth-tok" {
		t.Errorf("exchange Authorization = %q, want the GitHub OAuth token", exchangeAuth)
	}
	if exchangeCalls != 1 {
		t.Errorf("exchange calls = %d, want 1 (session token cached)", exchangeCalls)
	}
}

func TestCopilotInitiatorAgent(t *testing.T) {
	if got := initiator([]api.Message{{Role: "user"}, {Role: "assistant"}}); got != "agent" {
		t.Errorf("initiator = %q, want agent for an assistant-final history", got)
	}
	if got := initiator([]api.Message{{Role: "assistant"}, {Role: "tool"}}); got != "user" {
		t.Errorf("initiator = %q, want user for a tool-final history", got)
	}
}

func TestCopilotMissingCredentials(t *testing.T) {
	t.Setenv("GITHUB_COPILOT_ACCESS_TOKEN", "")
	t.Setenv("COPILOT_GITHUB_TOKEN", "")
	t.Setenv("GH_COPILOT_TOKEN", "")
	t.Setenv("GITHUB_COPILOT_TOKEN_DIR", t.TempDir())
	pv, err := api.NewProvider("github_copilot", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = pv.Complete(context.Background(), &api.ChatRequest{
		Model:    "gpt-4.1",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("err = %v, want an authentication api.Error", err)
	}
}
