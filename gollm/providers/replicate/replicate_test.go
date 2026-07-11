package replicate

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

// fakeReplicate serves the prediction lifecycle: create → poll → succeeded.
func fakeReplicate(t *testing.T, pollsUntilDone int) (*httptest.Server, *struct {
	createPath string
	createBody map[string]any
	polls      int
}) {
	t.Helper()
	state := &struct {
		createPath string
		createBody map[string]any
		polls      int
	}{}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			state.createPath = r.URL.Path
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &state.createBody)
			if got := r.Header.Get("Authorization"); got != "Bearer r8-test" {
				t.Errorf("Authorization = %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     "pred-1",
				"status": "starting",
				"urls":   map[string]string{"get": srv.URL + "/predictions/pred-1"},
			})
		case r.Method == http.MethodGet:
			state.polls++
			status := "processing"
			var output any
			if state.polls >= pollsUntilDone {
				status = "succeeded"
				output = []string{"Hello", " from", " replicate"}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "pred-1", "status": status, "output": output,
				"metrics": map[string]int{"input_token_count": 5, "output_token_count": 3},
			})
		}
	}))
	t.Cleanup(srv.Close)
	return srv, state
}

func TestReplicateCompletePollsToCompletion(t *testing.T) {
	srv, state := fakeReplicate(t, 2)
	p, err := api.NewProvider("replicate", api.ProviderConfig{BaseURL: srv.URL, APIKey: "r8-test"})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model: "meta/llama-3-70b-instruct",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be brief")},
			{Role: "user", Content: api.TextContent("hi")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if state.createPath != "/models/meta/llama-3-70b-instruct/predictions" {
		t.Errorf("create path = %q", state.createPath)
	}
	input, _ := state.createBody["input"].(map[string]any)
	promptText, _ := input["prompt"].(string)
	if promptText == "" {
		t.Fatalf("prompt missing from input: %v", state.createBody)
	}
	if state.polls < 2 {
		t.Errorf("polls = %d, want it to poll until succeeded", state.polls)
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "Hello from replicate" {
		t.Errorf("content = %q", got)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 8 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestReplicateVersionedModelUsesPredictionsEndpoint(t *testing.T) {
	srv, state := fakeReplicate(t, 1)
	p, _ := api.NewProvider("replicate", api.ProviderConfig{BaseURL: srv.URL, APIKey: "r8-test"})
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "meta/llama-2-70b:02e509c789964a7ea8736978a43525956ef40397be9033abf9fd2badfe68c9e3",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatal(err)
	}
	if state.createPath != "/predictions" {
		t.Errorf("create path = %q, want /predictions for a versioned model", state.createPath)
	}
	if v, _ := state.createBody["version"].(string); v == "" {
		t.Errorf("version missing from create body: %v", state.createBody)
	}
}

func TestReplicateStream(t *testing.T) {
	var streamed bool
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["stream"] != true {
				t.Errorf("create body stream = %v, want true", body["stream"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "pred-2", "status": "starting",
				"urls": map[string]string{"stream": srv.URL + "/stream/pred-2"},
			})
		case r.Method == http.MethodGet:
			streamed = true
			if got := r.Header.Get("Accept"); got != "text/event-stream" {
				t.Errorf("Accept = %q", got)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: output\ndata: Hel\n\n")
			fmt.Fprint(w, "event: output\ndata: lo\n\n")
			fmt.Fprint(w, "event: done\ndata: {}\n\n")
		}
	}))
	defer srv.Close()

	p, _ := api.NewProvider("replicate", api.ProviderConfig{BaseURL: srv.URL, APIKey: "r8-test"})
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "meta/llama-3-70b-instruct",
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
	if !streamed {
		t.Fatal("stream URL was never fetched")
	}
	resp := acc.Response()
	if got := resp.Choices[0].Message.Content.AsText(); got != "Hello" {
		t.Errorf("accumulated content = %q", got)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Errorf("finish = %q", resp.Choices[0].FinishReason)
	}
}
