package petals

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/based64god/gollm/api"
)

func TestPetalsGenerate(t *testing.T) {
	var gotForm map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotForm = map[string]string{}
		for k := range r.Form {
			gotForm[k] = r.Form.Get(k)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "outputs": "hi from the swarm"})
	}))
	defer srv.Close()

	t.Setenv("PETALS_API_BASE", srv.URL)
	p, err := api.NewProvider("petals", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "petals-team/StableBeluga2",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotForm["model"] != "petals-team/StableBeluga2" || gotForm["inputs"] != "hello" {
		t.Errorf("form = %v", gotForm)
	}
	if gotForm["max_new_tokens"] == "" {
		t.Error("max_new_tokens missing (the generate API requires it)")
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from the swarm" {
		t.Errorf("content = %q", got)
	}
}

func TestPetalsFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "traceback": "RuntimeError: boom\nstack..."})
	}))
	defer srv.Close()

	t.Setenv("PETALS_API_BASE", srv.URL)
	p, _ := api.NewProvider("petals", api.ProviderConfig{})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrInternalServer {
		t.Fatalf("err = %v, want internal-server api.Error carrying the traceback head", err)
	}
}
