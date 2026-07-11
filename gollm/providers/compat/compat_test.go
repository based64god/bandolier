package compat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

// capture records the last request a fake server received.
type capture struct {
	path   string
	auth   string
	header http.Header
	body   []byte
}

// fakeServer returns an httptest server that records each request into cap
// and replies with the given status and body.
func fakeServer(t *testing.T, cap *capture, status int, respHeader map[string]string, respBody string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		*cap = capture{path: r.URL.Path, auth: r.Header.Get("Authorization"), header: r.Header.Clone(), body: b}
		for k, v := range respHeader {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv
}

const completionBody = `{
	"id": "chatcmpl-abc123",
	"object": "chat.completion",
	"created": 1700000000,
	"model": "llama-3.3-70b-versatile",
	"choices": [
		{"index": 0, "message": {"role": "assistant", "content": "Hello!"}, "finish_reason": "stop"}
	],
	"usage": {"prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12}
}`

func newProvider(t *testing.T, name, baseURL string) api.Provider {
	t.Helper()
	p, err := api.NewProvider(name, api.ProviderConfig{BaseURL: baseURL, APIKey: "test-key"})
	if err != nil {
		t.Fatalf("NewProvider(%q): %v", name, err)
	}
	return p
}

// completionRoundTrip drives one Complete through a fake server and asserts
// request translation, auth, path, and unified response translation.
func completionRoundTrip(t *testing.T, name, model string) {
	t.Helper()
	var cap capture
	srv := fakeServer(t, &cap, 200, nil, completionBody)
	p := newProvider(t, name, srv.URL)

	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    model,
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if cap.path != "/chat/completions" {
		t.Errorf("path = %q, want /chat/completions", cap.path)
	}
	if cap.auth != "Bearer test-key" {
		t.Errorf("Authorization = %q, want Bearer test-key", cap.auth)
	}
	var wire struct {
		Model    string `json:"model"`
		Stream   bool   `json:"stream"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(cap.body, &wire); err != nil {
		t.Fatalf("decode outbound body: %v", err)
	}
	if wire.Model != model {
		t.Errorf("wire model = %q, want %q", wire.Model, model)
	}
	if wire.Stream {
		t.Error("wire stream = true on a Complete call")
	}
	if len(wire.Messages) != 1 || wire.Messages[0].Role != "user" || wire.Messages[0].Content != "hi" {
		t.Errorf("wire messages = %+v", wire.Messages)
	}

	if resp.ID != "chatcmpl-abc123" {
		t.Errorf("ID = %q", resp.ID)
	}
	if resp.Provider != name {
		t.Errorf("Provider = %q, want %q", resp.Provider, name)
	}
	if len(resp.Choices) != 1 || resp.Choices[0].Message.Content.AsText() != "Hello!" {
		t.Errorf("choices = %+v", resp.Choices)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Errorf("finish_reason = %q", resp.Choices[0].FinishReason)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 12 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestGroqCompletion(t *testing.T) {
	completionRoundTrip(t, "groq", "llama-3.3-70b-versatile")
}

func TestOpenRouterCompletion(t *testing.T) {
	completionRoundTrip(t, "openrouter", "meta-llama/llama-3.3-70b")
}

const streamBody = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"}}]}\n\n" +
	"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n" +
	"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":2,\"total_tokens\":4}}\n\n" +
	"data: [DONE]\n\n"

// streamRoundTrip drives one Stream end-to-end and returns the outbound wire
// body so callers can assert the stream_options quirk.
func streamRoundTrip(t *testing.T, name string) map[string]any {
	t.Helper()
	var cap capture
	srv := fakeServer(t, &cap, 200, map[string]string{"Content-Type": "text/event-stream"}, streamBody)
	p := newProvider(t, name, srv.URL)

	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		acc.Add(chunk)
	}
	resp := acc.Response()
	if got := resp.Choices[0].Message.Content.AsText(); got != "Hello" {
		t.Errorf("accumulated content = %q, want Hello", got)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 4 {
		t.Errorf("accumulated usage = %+v", resp.Usage)
	}

	var wire map[string]any
	if err := json.Unmarshal(cap.body, &wire); err != nil {
		t.Fatalf("decode outbound body: %v", err)
	}
	if wire["stream"] != true {
		t.Error("wire stream != true on a Stream call")
	}
	return wire
}

func TestGroqStreamSendsStreamOptions(t *testing.T) {
	wire := streamRoundTrip(t, "groq")
	so, ok := wire["stream_options"].(map[string]any)
	if !ok || so["include_usage"] != true {
		t.Errorf("stream_options = %v, want include_usage:true", wire["stream_options"])
	}
}

func TestTogetherStreamOmitsStreamOptions(t *testing.T) {
	wire := streamRoundTrip(t, "together")
	if _, present := wire["stream_options"]; present {
		t.Errorf("stream_options sent to a backend that rejects it: %v", wire["stream_options"])
	}
}

func TestErrorMapping(t *testing.T) {
	var cap capture
	srv := fakeServer(t, &cap, 429, map[string]string{"Retry-After": "7"},
		`{"error": {"message": "rate limited", "type": "rate_limit_error"}}`)
	p := newProvider(t, "groq", srv.URL)

	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error = %v, want *api.Error", err)
	}
	if apiErr.Type != api.ErrRateLimit {
		t.Errorf("Type = %q, want %q", apiErr.Type, api.ErrRateLimit)
	}
	if apiErr.StatusCode != 429 {
		t.Errorf("StatusCode = %d, want 429", apiErr.StatusCode)
	}
	if apiErr.Provider != "groq" {
		t.Errorf("Provider = %q, want groq", apiErr.Provider)
	}
	if apiErr.RetryAfter.Seconds() != 7 {
		t.Errorf("RetryAfter = %v, want 7s", apiErr.RetryAfter)
	}
	if !apiErr.Retryable() {
		t.Error("429 should be retryable")
	}
}

func TestEmbeddingsGating(t *testing.T) {
	// mistral supports embeddings; assert the round trip.
	var cap capture
	srv := fakeServer(t, &cap, 200, nil,
		`{"object":"list","model":"mistral-embed","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2]}],"usage":{"prompt_tokens":2,"total_tokens":2}}`)
	p := newProvider(t, "mistral", srv.URL)
	resp, err := p.Embed(context.Background(), &api.EmbeddingRequest{
		Model: "mistral-embed",
		Input: api.StringOrSlice{"hello"},
	})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if cap.path != "/embeddings" {
		t.Errorf("path = %q, want /embeddings", cap.path)
	}
	if cap.auth != "Bearer test-key" {
		t.Errorf("Authorization = %q", cap.auth)
	}
	if len(resp.Data) != 1 || len(resp.Data[0].Embedding) != 2 {
		t.Errorf("data = %+v", resp.Data)
	}

	// groq does not; Embed must fail without touching the network.
	g := newProvider(t, "groq", srv.URL)
	_, err = g.Embed(context.Background(), &api.EmbeddingRequest{Model: "m", Input: api.StringOrSlice{"x"}})
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrNotSupported {
		t.Errorf("groq Embed error = %v, want %q", err, api.ErrNotSupported)
	}
}

func TestEnvKeyFallback(t *testing.T) {
	var cap capture
	srv := fakeServer(t, &cap, 200, nil, completionBody)

	t.Setenv("GROQ_API_KEY", "env-key")
	p, err := api.NewProvider("groq", api.ProviderConfig{BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if cap.auth != "Bearer env-key" {
		t.Errorf("Authorization = %q, want Bearer env-key", cap.auth)
	}

	// Secondary env spelling is honored when the primary is unset.
	t.Setenv("TOGETHER_API_KEY", "")
	t.Setenv("TOGETHERAI_API_KEY", "alt-key")
	tp, err := api.NewProvider("together", api.ProviderConfig{BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, err := tp.Complete(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if cap.auth != "Bearer alt-key" {
		t.Errorf("Authorization = %q, want Bearer alt-key", cap.auth)
	}
}

// TestAllProvidersRegistered walks the whole defaults table: every entry must
// resolve to itself, construct, and satisfy the table invariants (a name, a
// credential source, and — unless it's env-pointed self-hosted — an endpoint).
func TestAllProvidersRegistered(t *testing.T) {
	if len(defaults) < 60 {
		t.Errorf("defaults has %d entries — the litellm-parity table should be large", len(defaults))
	}
	seen := map[string]bool{}
	for _, d := range defaults {
		if d.Name == "" {
			t.Fatal("entry with empty Name")
		}
		if seen[d.Name] {
			t.Errorf("duplicate provider %q", d.Name)
		}
		seen[d.Name] = true
		if d.BaseURL == "" && len(d.BaseURLEnvs) == 0 {
			t.Errorf("%s: no BaseURL and no BaseURLEnvs — unreachable", d.Name)
		}
		if len(d.APIKeyEnvs) == 0 && d.DefaultAPIKey == "" {
			t.Errorf("%s: no APIKeyEnvs and no DefaultAPIKey — cannot authenticate", d.Name)
		}

		canonical, ok := api.Resolve(d.Name)
		if !ok {
			t.Errorf("Resolve(%q): not registered", d.Name)
			continue
		}
		if canonical != d.Name {
			t.Errorf("Resolve(%q) = %q, want itself (canonical)", d.Name, canonical)
		}
		p, err := api.NewProvider(d.Name, api.ProviderConfig{BaseURL: "http://127.0.0.1:0", APIKey: "test-key"})
		if err != nil {
			t.Errorf("NewProvider(%q): %v", d.Name, err)
			continue
		}
		if p.Name() != d.Name {
			t.Errorf("Name() = %q, want %q", p.Name(), d.Name)
		}
	}
}

func TestAliases(t *testing.T) {
	for alias, canonical := range aliases {
		got, ok := api.Resolve(alias)
		if !ok {
			t.Errorf("Resolve(%q): not registered", alias)
			continue
		}
		if got != canonical {
			t.Errorf("Resolve(%q) = %q, want %q", alias, got, canonical)
		}
		p, err := api.NewProvider(alias, api.ProviderConfig{BaseURL: "http://127.0.0.1:0", APIKey: "test-key"})
		if err != nil {
			t.Errorf("NewProvider(%q): %v", alias, err)
			continue
		}
		if p.Name() != canonical {
			t.Errorf("NewProvider(%q).Name() = %q, want %q", alias, p.Name(), canonical)
		}
	}
}

// TestSelfHostedBaseURLFromEnv exercises the env-pointed endpoint plus the
// placeholder credential: a hosted_vllm deployment named only by
// HOSTED_VLLM_API_BASE must be reachable with no key configured anywhere.
func TestSelfHostedBaseURLFromEnv(t *testing.T) {
	var cap capture
	srv := fakeServer(t, &cap, 200, nil, completionBody)
	t.Setenv("HOSTED_VLLM_API_BASE", srv.URL)
	t.Setenv("HOSTED_VLLM_API_KEY", "")

	p, err := api.NewProvider("hosted_vllm", api.ProviderConfig{})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if cap.path != "/chat/completions" {
		t.Errorf("path = %q", cap.path)
	}
	if cap.auth != "Bearer "+placeholderKey {
		t.Errorf("Authorization = %q, want the placeholder bearer", cap.auth)
	}
}

// TestVLLMAliasAndEnvSpellings: the `vllm` alias reaches hosted_vllm, the
// VLLM_* env spellings are honored, and streams request usage reporting
// (vLLM's OpenAI server supports stream_options.include_usage).
func TestVLLMAliasAndEnvSpellings(t *testing.T) {
	var cap capture
	srv := fakeServer(t, &cap, 200, map[string]string{"Content-Type": "text/event-stream"}, streamBody)
	t.Setenv("HOSTED_VLLM_API_BASE", "")
	t.Setenv("HOSTED_VLLM_API_KEY", "")
	t.Setenv("VLLM_API_BASE", srv.URL)
	t.Setenv("VLLM_API_KEY", "vllm-key")

	p, err := api.NewProvider("vllm", api.ProviderConfig{})
	if err != nil {
		t.Fatalf("NewProvider(vllm): %v", err)
	}
	if p.Name() != "hosted_vllm" {
		t.Errorf("Name() = %q, want hosted_vllm", p.Name())
	}
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "qwen3-coder",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()
	for {
		if _, err := stream.Recv(); err == io.EOF {
			break
		} else if err != nil {
			t.Fatalf("Recv: %v", err)
		}
	}

	if cap.auth != "Bearer vllm-key" {
		t.Errorf("Authorization = %q, want the VLLM_API_KEY bearer", cap.auth)
	}
	var wire map[string]any
	if err := json.Unmarshal(cap.body, &wire); err != nil {
		t.Fatalf("decode outbound body: %v", err)
	}
	so, ok := wire["stream_options"].(map[string]any)
	if !ok || so["include_usage"] != true {
		t.Errorf("stream_options = %v, want include_usage:true", wire["stream_options"])
	}
}

// TestMissingEndpointError: a self-hosted provider with neither an env-named
// nor configured endpoint must fail with a message naming the env var.
func TestMissingEndpointError(t *testing.T) {
	t.Setenv("DATABRICKS_API_BASE", "")
	p, err := api.NewProvider("databricks", api.ProviderConfig{APIKey: "k"})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	_, err = p.Complete(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *api.Error", err)
	}
	if !strings.Contains(apiErr.Message, "DATABRICKS_API_BASE") {
		t.Errorf("error should name the env var, got: %s", apiErr.Message)
	}
}

// TestNoEnvNeededForConstruction guards the factory contract: constructing
// with an explicit key must never consult the environment.
func TestNoEnvNeededForConstruction(t *testing.T) {
	if _, err := api.NewProvider("cerebras", api.ProviderConfig{BaseURL: "http://example.invalid", APIKey: "k"}); err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	var unknown *api.Error
	_, err := api.NewProvider("definitely-not-registered", api.ProviderConfig{})
	if !errors.As(err, &unknown) || unknown.Type != api.ErrBadRequest {
		t.Errorf("unknown provider error = %v, want %q", err, api.ErrBadRequest)
	}
}
