package triton

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

func TestTritonCompleteBuildsModelPath(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]string{"text_output": "hi from triton"})
	}))
	defer srv.Close()

	t.Setenv("TRITON_API_BASE", srv.URL)
	p, err := api.NewProvider("triton", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	maxTok := 64
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:     "llama3",
		MaxTokens: &maxTok,
		Messages:  []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v2/models/llama3/generate" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["text_input"] != "hello" {
		t.Errorf("text_input = %v", gotBody["text_input"])
	}
	params, _ := gotBody["parameters"].(map[string]any)
	if params["max_tokens"] != float64(64) {
		t.Errorf("parameters = %v", params)
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from triton" {
		t.Errorf("content = %q", got)
	}
}

func TestTritonStreamAppendsSuffix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/models/llama3/generate_stream" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"text_output":"Hel"}`+"\n\n"+`data: {"text_output":"lo"}`+"\n\n")
	}))
	defer srv.Close()

	t.Setenv("TRITON_API_BASE", srv.URL)
	p, _ := api.NewProvider("triton", api.ProviderConfig{})
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "llama3",
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
	if got := acc.Response().Choices[0].Message.Content.AsText(); got != "Hello" {
		t.Errorf("accumulated = %q", got)
	}
}

func TestTritonRequiresBaseAndRejectsInfer(t *testing.T) {
	t.Setenv("TRITON_API_BASE", "")
	p, _ := api.NewProvider("triton", api.ProviderConfig{})
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model: "m", Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err == nil {
		t.Fatal("want error without TRITON_API_BASE")
	}

	t.Setenv("TRITON_API_BASE", "http://host/v2/models/m/infer")
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model: "m", Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err == nil {
		t.Fatal("want error for the /infer tensor protocol")
	}
}
