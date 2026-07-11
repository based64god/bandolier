package predibase

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/based64god/gollm/api"
)

func TestPredibaseCompleteURLAndTranslation(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"generated_text": "hi from predibase",
			"details":        map[string]any{"finish_reason": "length", "generated_tokens": 8, "prompt_tokens": 4},
		})
	}))
	defer srv.Close()

	t.Setenv("PREDIBASE_API_BASE", srv.URL)
	t.Setenv("PREDIBASE_TENANT_ID", "tenant-1")
	t.Setenv("PREDIBASE_API_KEY", "pb-key")
	p, err := api.NewProvider("predibase", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "llama-3-8b",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/tenant-1/deployments/v2/llms/llama-3-8b/generate" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Bearer pb-key" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotBody["inputs"] != "hello" {
		t.Errorf("inputs = %v", gotBody["inputs"])
	}
	params, _ := gotBody["parameters"].(map[string]any)
	if params["max_new_tokens"] != float64(defaultMaxNewTokens) {
		t.Errorf("max_new_tokens = %v (TGI requires it)", params["max_new_tokens"])
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from predibase" {
		t.Errorf("content = %q", got)
	}
	if resp.Choices[0].FinishReason != "length" {
		t.Errorf("finish = %q", resp.Choices[0].FinishReason)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 12 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestPredibaseStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tenant-1/deployments/v2/llms/m/generate_stream" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"token":{"text":"Hel"},"generated_text":null}`+"\n\n")
		fmt.Fprint(w, `data: {"token":{"text":"lo"},"generated_text":"Hello","details":{"finish_reason":"eos_token"}}`+"\n\n")
	}))
	defer srv.Close()

	t.Setenv("PREDIBASE_API_BASE", srv.URL)
	t.Setenv("PREDIBASE_TENANT_ID", "tenant-1")
	t.Setenv("PREDIBASE_API_KEY", "pb-key")
	p, _ := api.NewProvider("predibase", api.ProviderConfig{})
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		acc.Add(chunk)
	}
	resp := acc.Response()
	if got := resp.Choices[0].Message.Content.AsText(); got != "Hello" {
		t.Errorf("accumulated = %q", got)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Errorf("finish = %q", resp.Choices[0].FinishReason)
	}
}

func TestPredibaseMissingTenant(t *testing.T) {
	t.Setenv("PREDIBASE_TENANT_ID", "")
	t.Setenv("PREDIBASE_API_KEY", "pb-key")
	p, _ := api.NewProvider("predibase", api.ProviderConfig{})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model: "m", Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrBadRequest {
		t.Fatalf("err = %v, want bad-request about the tenant", err)
	}
}
