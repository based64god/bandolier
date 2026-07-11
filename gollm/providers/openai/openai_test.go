package openai

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/based64god/gollm/api"
)

// sseServer streams the given payloads as SSE data lines followed by [DONE].
func sseServer(t *testing.T, payloads ...string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, p := range payloads {
			fmt.Fprintf(w, "data: %s\n\n", p)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
}

func testProvider(t *testing.T, baseURL string) api.Provider {
	t.Helper()
	p, err := NewFactory(Defaults{
		Name:                   "openai",
		BaseURL:                baseURL,
		StreamOptionsSupported: true,
	})(api.ProviderConfig{APIKey: "test-key"})
	if err != nil {
		t.Fatalf("NewFactory: %v", err)
	}
	return p
}

// A mid-stream {"error": ...} payload unmarshals cleanly into an empty
// ChatChunk, so Stream must probe for it explicitly rather than only on
// decode failure — otherwise upstream failures degrade to empty chunk + EOF.
func TestStreamSurfacesMidStreamError(t *testing.T) {
	srv := sseServer(t,
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}`,
		`{"error":{"message":"upstream boom","type":"server_error"}}`,
	)
	defer srv.Close()

	p := testProvider(t, srv.URL)
	stream, err := p.Stream(context.Background(), &api.ChatRequest{Model: "gpt-4o"})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	chunk, err := stream.Recv()
	if err != nil {
		t.Fatalf("first Recv: %v", err)
	}
	if len(chunk.Choices) == 0 || chunk.Choices[0].Delta.Content != "hello" {
		t.Fatalf("first chunk = %+v, want content %q", chunk, "hello")
	}

	_, err = stream.Recv()
	if err == nil || err == io.EOF {
		t.Fatalf("second Recv err = %v, want *api.Error", err)
	}
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("second Recv err = %T (%v), want *api.Error", err, err)
	}
	if apiErr.Message != "upstream boom" {
		t.Errorf("Message = %q, want %q", apiErr.Message, "upstream boom")
	}
	if apiErr.Type != api.ErrInternalServer {
		t.Errorf("Type = %q, want %q", apiErr.Type, api.ErrInternalServer)
	}
	if apiErr.Provider != "openai" {
		t.Errorf("Provider = %q, want %q", apiErr.Provider, "openai")
	}
}

// Chunks without an "error" key — including an explicit "error": null — must
// stream through untouched.
func TestStreamNormalChunksUnaffectedByErrorSniff(t *testing.T) {
	srv := sseServer(t,
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"a"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","error":null,"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}]}`,
	)
	defer srv.Close()

	p := testProvider(t, srv.URL)
	stream, err := p.Stream(context.Background(), &api.ChatRequest{Model: "gpt-4o"})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	var got string
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		for _, c := range chunk.Choices {
			got += c.Delta.Content
		}
	}
	if got != "ab" {
		t.Errorf("accumulated content = %q, want %q", got, "ab")
	}
}

func TestSniffStreamError(t *testing.T) {
	cases := []struct {
		name    string
		data    string
		wantErr bool
		wantMsg string
	}{
		{"object error", `{"error":{"message":"boom","type":"server_error"}}`, true, "boom"},
		{"string error", `{"error":"boom"}`, true, ""},
		{"null error", `{"error":null,"choices":[]}`, false, ""},
		{"no error key", `{"id":"c1","choices":[]}`, false, ""},
		{"not json", `garbage`, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sniffStreamError("openai", "gpt-4o", []byte(tc.data))
			if (got != nil) != tc.wantErr {
				t.Fatalf("sniffStreamError(%q) = %v, wantErr=%v", tc.data, got, tc.wantErr)
			}
			if tc.wantMsg != "" && got.Message != tc.wantMsg {
				t.Errorf("Message = %q, want %q", got.Message, tc.wantMsg)
			}
		})
	}
}
