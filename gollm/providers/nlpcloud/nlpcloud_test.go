package nlpcloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/based64god/gollm/api"
)

func TestNLPCloudCompleteAndFakeStream(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"generated_text": "hi from nlpcloud", "nb_generated_tokens": 6, "nb_input_tokens": 3,
		})
	}))
	defer srv.Close()

	t.Setenv("NLP_CLOUD_API_BASE", srv.URL)
	t.Setenv("NLP_CLOUD_API_KEY", "nlp-key")
	p, err := api.NewProvider("nlp_cloud", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}

	maxTok := 100
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:     "finetuned-llama-3-70b",
		MaxTokens: &maxTok,
		Messages:  []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/finetuned-llama-3-70b/generation" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Token nlp-key" {
		t.Errorf("Authorization = %q, want the Token scheme", gotAuth)
	}
	if gotBody["text"] != "hello" || gotBody["max_length"] != float64(100) {
		t.Errorf("body = %v", gotBody)
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from nlpcloud" {
		t.Errorf("content = %q", got)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 9 {
		t.Errorf("usage = %+v", resp.Usage)
	}

	// Stream is a single-chunk replay of Complete.
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "finetuned-llama-3-70b",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
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
	got := acc.Response()
	if text := got.Choices[0].Message.Content.AsText(); text != "hi from nlpcloud" {
		t.Errorf("streamed content = %q", text)
	}
	if got.Usage == nil || got.Usage.TotalTokens != 9 {
		t.Errorf("streamed usage = %+v", got.Usage)
	}
}
