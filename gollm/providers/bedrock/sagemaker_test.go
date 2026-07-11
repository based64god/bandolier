package bedrock

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

func newSageMakerProvider(t *testing.T, baseURL string) api.Provider {
	t.Helper()
	clearAWSEnv(t)
	p, err := api.NewProvider("sagemaker", api.ProviderConfig{
		BaseURL: baseURL,
		Extra: map[string]string{
			"access_key_id":     "AKIA_TEST",
			"secret_access_key": "secret",
			"region":            "us-east-1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSageMakerComplete(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"sm-1","object":"chat.completion","model":"served","choices":[{"index":0,"message":{"role":"assistant","content":"hi from sagemaker"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`)
	}))
	defer srv.Close()

	p := newSageMakerProvider(t, srv.URL)
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "my-endpoint",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if gotPath != "/endpoints/my-endpoint/invocations" {
		t.Errorf("path = %q", gotPath)
	}
	// SigV4-signed for the sagemaker service.
	if !strings.Contains(gotAuth, "AWS4-HMAC-SHA256") || !strings.Contains(gotAuth, "/sagemaker/aws4_request") {
		t.Errorf("Authorization = %q, want a SigV4 sagemaker signature", gotAuth)
	}
	if gotBody["stream"] != nil && gotBody["stream"] != false {
		t.Errorf("stream = %v on a Complete call", gotBody["stream"])
	}
	msgs, _ := gotBody["messages"].([]any)
	if len(msgs) != 1 {
		t.Errorf("messages = %v", gotBody["messages"])
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from sagemaker" {
		t.Errorf("content = %q", got)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 7 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

// TestSageMakerStream exercises the eventstream framing: SSE-ish "data: {...}"
// fragments, one of them split across two frames, must reassemble into chunks.
func TestSageMakerStream(t *testing.T) {
	chunk1 := `data: {"id":"sm-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}`
	chunk2 := `data: {"id":"sm-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/invocations-response-stream") {
			t.Errorf("path = %q, want the streaming action", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
		w.Write(eventFrame("PayloadPart", chunk1))
		// The second JSON document arrives split across two frames.
		w.Write(eventFrame("PayloadPart", chunk2[:40]))
		w.Write(eventFrame("PayloadPart", chunk2[40:]))
	}))
	defer srv.Close()

	p := newSageMakerProvider(t, srv.URL)
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "my-endpoint",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	n := 0
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		n++
		acc.Add(chunk)
	}
	if n != 2 {
		t.Errorf("chunks = %d, want 2 (split frame must reassemble)", n)
	}
	resp := acc.Response()
	if got := resp.Choices[0].Message.Content.AsText(); got != "Hello" {
		t.Errorf("accumulated content = %q, want Hello", got)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Errorf("finish = %q", resp.Choices[0].FinishReason)
	}
}
