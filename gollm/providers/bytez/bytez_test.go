package bytez

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

func TestBytezComplete(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":  nil,
			"output": map[string]string{"role": "assistant", "content": "hi from bytez"},
		})
	}))
	defer srv.Close()

	t.Setenv("BYTEZ_API_BASE", srv.URL)
	t.Setenv("BYTEZ_API_KEY", "bz-key")
	p, err := api.NewProvider("bytez", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "microsoft/Phi-3-mini-4k-instruct",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/microsoft/Phi-3-mini-4k-instruct" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Key bz-key" {
		t.Errorf("Authorization = %q, want the Key scheme", gotAuth)
	}
	if gotBody["stream"] != false {
		t.Errorf("stream = %v", gotBody["stream"])
	}
	msgs, _ := gotBody["messages"].([]any)
	if len(msgs) != 1 {
		t.Errorf("messages = %v", gotBody["messages"])
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from bytez" {
		t.Errorf("content = %q", got)
	}
}

func TestBytezRawTextStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true {
			t.Errorf("stream = %v", body["stream"])
		}
		// Raw text chunks, no SSE framing.
		flusher := w.(http.Flusher)
		fmt.Fprint(w, "Hel")
		flusher.Flush()
		fmt.Fprint(w, "lo")
	}))
	defer srv.Close()

	t.Setenv("BYTEZ_API_BASE", srv.URL)
	t.Setenv("BYTEZ_API_KEY", "bz-key")
	p, _ := api.NewProvider("bytez", api.ProviderConfig{})
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "m/m",
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

func TestBytezErrorPayload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "model is cold", "output": nil})
	}))
	defer srv.Close()

	t.Setenv("BYTEZ_API_BASE", srv.URL)
	t.Setenv("BYTEZ_API_KEY", "bz-key")
	p, _ := api.NewProvider("bytez", api.ProviderConfig{})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "m/m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err == nil {
		t.Fatal("want error for a non-null error field")
	}
}
