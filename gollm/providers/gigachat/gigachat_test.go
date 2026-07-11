package gigachat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

func TestGigaChatOAuthAndChat(t *testing.T) {
	var oauthCalls int
	oauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		oauthCalls++
		if got := r.Header.Get("Authorization"); got != "Basic YXV0aC1rZXk=" {
			t.Errorf("Authorization = %q, want the Basic authorization key", got)
		}
		if r.Header.Get("RqUID") == "" {
			t.Error("RqUID header missing")
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if got := r.Form.Get("scope"); got != "GIGACHAT_API_PERS" {
			t.Errorf("scope = %q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "giga-tok",
			"expires_at":   time.Now().Add(time.Hour).UnixMilli(),
		})
	}))
	defer oauth.Close()

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer giga-tok" {
			t.Errorf("Authorization = %q, want the minted access token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"g1","object":"chat.completion","model":"GigaChat-Pro","choices":[{"index":0,"message":{"role":"assistant","content":"privet"},"finish_reason":"stop"}]}`)
	}))
	defer backend.Close()

	t.Setenv("GIGACHAT_ACCESS_TOKEN", "")
	t.Setenv("GIGACHAT_CREDENTIALS", "YXV0aC1rZXk=")
	pv, err := api.NewProvider("gigachat", api.ProviderConfig{BaseURL: backend.URL})
	if err != nil {
		t.Fatal(err)
	}
	p := pv.(*Provider)
	p.auth.authURL = oauth.URL

	for i := 0; i < 2; i++ {
		resp, err := p.Complete(context.Background(), &api.ChatRequest{
			Model:    "GigaChat-Pro",
			Messages: []api.Message{{Role: "user", Content: api.TextContent("привет")}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if got := resp.Choices[0].Message.Content.AsText(); got != "privet" {
			t.Errorf("content = %q", got)
		}
	}
	if oauthCalls != 1 {
		t.Errorf("oauth calls = %d, want 1 (token cached)", oauthCalls)
	}
}

func TestGigaChatPreMintedToken(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer pre-minted" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"g1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`)
	}))
	defer backend.Close()

	t.Setenv("GIGACHAT_ACCESS_TOKEN", "pre-minted")
	p, err := api.NewProvider("gigachat", api.ProviderConfig{BaseURL: backend.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "GigaChat",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestGigaChatMissingCredentials(t *testing.T) {
	t.Setenv("GIGACHAT_ACCESS_TOKEN", "")
	t.Setenv("GIGACHAT_CREDENTIALS", "")
	t.Setenv("GIGACHAT_API_KEY", "")
	t.Setenv("GIGACHAT_AUTH_KEY", "")
	p, _ := api.NewProvider("gigachat", api.ProviderConfig{})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "GigaChat",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("err = %v, want authentication api.Error", err)
	}
}
