package azure

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

// capture records the last request the fake server received.
type capture struct {
	method  string
	path    string
	query   map[string]string
	headers http.Header
	body    map[string]any
}

// newServer returns a fake Azure endpoint that records the request and
// replies with respBody (raw bytes, Content-Type from contentType).
func newServer(t *testing.T, status int, contentType string, respBody string, header http.Header) (*httptest.Server, *capture) {
	t.Helper()
	cap := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.query = map[string]string{}
		for k, v := range r.URL.Query() {
			cap.query[k] = v[0]
		}
		cap.headers = r.Header.Clone()
		raw, _ := io.ReadAll(r.Body)
		cap.body = nil
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &cap.body); err != nil {
				t.Errorf("request body is not JSON: %v\n%s", err, raw)
			}
		}
		for k, vs := range header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(status)
		io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, cap
}

func newProvider(t *testing.T, cfg api.ProviderConfig) api.Provider {
	t.Helper()
	p, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return p
}

const completionJSON = `{
	"id": "chatcmpl-123",
	"object": "chat.completion",
	"created": 1700000000,
	"model": "gpt-4o-2024-08-06",
	"choices": [{
		"index": 0,
		"message": {"role": "assistant", "content": "Hello from Azure"},
		"finish_reason": "stop"
	}],
	"usage": {"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13}
}`

func TestCompleteTranslation(t *testing.T) {
	t.Setenv("AZURE_API_VERSION", "") // hermetic: the default-version assertion below must not see a real env value
	srv, cap := newServer(t, 200, "application/json", completionJSON, nil)
	p := newProvider(t, api.ProviderConfig{BaseURL: srv.URL, APIKey: "test-key"})

	temp := 0.5
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:       "my-gpt4o-deployment",
		Messages:    []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		Temperature: &temp,
		Extra:       map[string]any{"logprobs": true},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	// Outbound transport: deployment URL, api-version, api-key header.
	if want := "/openai/deployments/my-gpt4o-deployment/chat/completions"; cap.path != want {
		t.Errorf("path = %q, want %q", cap.path, want)
	}
	if got := cap.query["api-version"]; got != defaultAPIVersion {
		t.Errorf("api-version = %q, want %q", got, defaultAPIVersion)
	}
	if got := cap.headers.Get("api-key"); got != "test-key" {
		t.Errorf("api-key header = %q, want %q", got, "test-key")
	}
	if got := cap.headers.Get("Authorization"); got != "" {
		t.Errorf("Authorization header = %q, want unset", got)
	}

	// Outbound body: model still sent (Azure ignores it), typed + Extra fields.
	if got := cap.body["model"]; got != "my-gpt4o-deployment" {
		t.Errorf("body model = %v, want deployment name", got)
	}
	if got := cap.body["temperature"]; got != 0.5 {
		t.Errorf("body temperature = %v, want 0.5", got)
	}
	if got := cap.body["logprobs"]; got != true {
		t.Errorf("body logprobs = %v, want Extra passthrough true", got)
	}
	if _, ok := cap.body["stream"]; ok {
		t.Errorf("body stream present on non-streaming call")
	}

	// Response translation to unified form.
	if resp.ID != "chatcmpl-123" || resp.Model != "gpt-4o-2024-08-06" {
		t.Errorf("resp id/model = %q/%q", resp.ID, resp.Model)
	}
	if resp.Provider != "azure" {
		t.Errorf("resp.Provider = %q, want azure", resp.Provider)
	}
	if len(resp.Choices) != 1 || resp.Choices[0].Message.Content.AsText() != "Hello from Azure" {
		t.Errorf("choices = %+v", resp.Choices)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 13 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestStream(t *testing.T) {
	body := strings.Join([]string{
		`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}`,
		"",
		`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}`,
		"",
		`data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`,
		"",
		`data: [DONE]`,
		"",
	}, "\n")
	srv, cap := newServer(t, 200, "text/event-stream", body, nil)
	p := newProvider(t, api.ProviderConfig{BaseURL: srv.URL, APIKey: "test-key"})

	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "my-gpt4o-deployment",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
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
			t.Fatalf("Recv: %v", err)
		}
		acc.Add(chunk)
		n++
	}
	if n != 3 {
		t.Errorf("received %d chunks, want 3", n)
	}

	if cap.body["stream"] != true {
		t.Errorf("body stream = %v, want true", cap.body["stream"])
	}
	so, _ := cap.body["stream_options"].(map[string]any)
	if so == nil || so["include_usage"] != true {
		t.Errorf("body stream_options = %v, want include_usage true", cap.body["stream_options"])
	}

	final := acc.Response()
	if got := final.Choices[0].Message.Content.AsText(); got != "Hello" {
		t.Errorf("accumulated content = %q, want %q", got, "Hello")
	}
	if final.Choices[0].FinishReason != "stop" {
		t.Errorf("finish_reason = %q, want stop", final.Choices[0].FinishReason)
	}
	if final.Usage == nil || final.Usage.TotalTokens != 5 {
		t.Errorf("usage = %+v", final.Usage)
	}
}

func TestErrorMapping(t *testing.T) {
	errBody := `{"error":{"message":"Requests to the ChatCompletions_Create Operation have exceeded token rate limit","type":"","code":"429"}}`
	srv, _ := newServer(t, 429, "application/json", errBody, http.Header{"Retry-After": []string{"7"}})
	p := newProvider(t, api.ProviderConfig{BaseURL: srv.URL, APIKey: "test-key"})

	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "my-gpt4o-deployment",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error = %v, want *api.Error", err)
	}
	if apiErr.Type != api.ErrRateLimit || apiErr.StatusCode != 429 {
		t.Errorf("type/status = %v/%d, want rate_limit_error/429", apiErr.Type, apiErr.StatusCode)
	}
	if apiErr.Provider != "azure" || apiErr.Model != "my-gpt4o-deployment" {
		t.Errorf("provider/model = %q/%q", apiErr.Provider, apiErr.Model)
	}
	if apiErr.RetryAfter != 7*time.Second {
		t.Errorf("retryAfter = %v, want 7s", apiErr.RetryAfter)
	}
	if !strings.Contains(apiErr.Message, "token rate limit") {
		t.Errorf("message = %q", apiErr.Message)
	}
}

func TestContentFilterMapping(t *testing.T) {
	errBody := `{"error":{"message":"The response was filtered due to the prompt triggering Azure OpenAI's content management policy.","code":"content_filter"}}`
	srv, _ := newServer(t, 400, "application/json", errBody, nil)
	p := newProvider(t, api.ProviderConfig{BaseURL: srv.URL, APIKey: "test-key"})

	_, err := p.Complete(context.Background(), &api.ChatRequest{Model: "dep"})
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error = %v, want *api.Error", err)
	}
	if apiErr.Type != api.ErrContentPolicy {
		t.Errorf("type = %v, want content_policy_violation", apiErr.Type)
	}
}

func TestEmbed(t *testing.T) {
	respBody := `{"object":"list","model":"text-embedding-3-small","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2]}],"usage":{"prompt_tokens":2,"total_tokens":2}}`
	srv, cap := newServer(t, 200, "application/json", respBody, nil)
	p := newProvider(t, api.ProviderConfig{BaseURL: srv.URL, APIKey: "test-key"})

	resp, err := p.Embed(context.Background(), &api.EmbeddingRequest{
		Model: "my-embed-deployment",
		Input: api.StringOrSlice{"hello"},
	})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if want := "/openai/deployments/my-embed-deployment/embeddings"; cap.path != want {
		t.Errorf("path = %q, want %q", cap.path, want)
	}
	if got := cap.headers.Get("api-key"); got != "test-key" {
		t.Errorf("api-key header = %q", got)
	}
	if got := cap.body["input"]; got != "hello" {
		t.Errorf("body input = %v, want single-string form", got)
	}
	if len(resp.Data) != 1 || len(resp.Data[0].Embedding) != 2 {
		t.Errorf("data = %+v", resp.Data)
	}
}

func TestMissingBase(t *testing.T) {
	t.Setenv("AZURE_API_BASE", "")
	p := newProvider(t, api.ProviderConfig{APIKey: "test-key"})

	_, err := p.Complete(context.Background(), &api.ChatRequest{Model: "dep"})
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error = %v, want *api.Error", err)
	}
	if apiErr.Type != api.ErrAuthentication {
		t.Errorf("type = %v, want authentication_error", apiErr.Type)
	}
	if !strings.Contains(apiErr.Message, "AZURE_API_BASE") {
		t.Errorf("message = %q, want AZURE_API_BASE hint", apiErr.Message)
	}
}

func TestMissingKey(t *testing.T) {
	t.Setenv("AZURE_API_KEY", "")
	t.Setenv("AZURE_OPENAI_API_KEY", "")
	p := newProvider(t, api.ProviderConfig{BaseURL: "https://myres.openai.azure.com"})

	_, err := p.Complete(context.Background(), &api.ChatRequest{Model: "dep"})
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error = %v, want *api.Error", err)
	}
	if apiErr.Type != api.ErrAuthentication || !strings.Contains(apiErr.Message, "AZURE_API_KEY") {
		t.Errorf("err = %v, want auth error naming AZURE_API_KEY", apiErr)
	}
}

func TestEnvFallbacks(t *testing.T) {
	srv, cap := newServer(t, 200, "application/json", completionJSON, nil)
	t.Setenv("AZURE_API_BASE", srv.URL)
	t.Setenv("AZURE_API_KEY", "")
	t.Setenv("AZURE_OPENAI_API_KEY", "legacy-env-key") // fallback env is used when AZURE_API_KEY is empty
	t.Setenv("AZURE_API_VERSION", "2024-06-01")
	p := newProvider(t, api.ProviderConfig{})

	if _, err := p.Complete(context.Background(), &api.ChatRequest{Model: "dep"}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got := cap.headers.Get("api-key"); got != "legacy-env-key" {
		t.Errorf("api-key header = %q, want env fallback key", got)
	}
	if got := cap.query["api-version"]; got != "2024-06-01" {
		t.Errorf("api-version = %q, want env override", got)
	}
}

func TestConfigAPIVersionAndRequestOverrides(t *testing.T) {
	srv, cap := newServer(t, 200, "application/json", completionJSON, nil)
	p := newProvider(t, api.ProviderConfig{BaseURL: "https://unreachable.invalid", APIKey: "cfg-key", APIVersion: "2023-05-15"})

	// Per-request BaseURL/APIKey/Headers must override config.
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:   "dep",
		APIKey:  "req-key",
		BaseURL: srv.URL,
		Headers: map[string]string{"X-Trace": "abc"},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got := cap.headers.Get("api-key"); got != "req-key" {
		t.Errorf("api-key header = %q, want per-request key", got)
	}
	if got := cap.query["api-version"]; got != "2023-05-15" {
		t.Errorf("api-version = %q, want config version", got)
	}
	if got := cap.headers.Get("X-Trace"); got != "abc" {
		t.Errorf("X-Trace header = %q, want abc", got)
	}
}

func TestBaseAlreadyContainsDeployment(t *testing.T) {
	srv, cap := newServer(t, 200, "application/json", completionJSON, nil)
	// A base that already names the deployment (openai-python convention) is
	// used verbatim; only the operation is appended.
	base := srv.URL + "/openai/deployments/pinned-dep"
	p := newProvider(t, api.ProviderConfig{BaseURL: base, APIKey: "test-key"})

	if _, err := p.Complete(context.Background(), &api.ChatRequest{Model: "ignored"}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if want := "/openai/deployments/pinned-dep/chat/completions"; cap.path != want {
		t.Errorf("path = %q, want %q", cap.path, want)
	}
}

func TestRegistration(t *testing.T) {
	for _, name := range []string{"azure", "azure_openai"} {
		canonical, ok := api.Resolve(name)
		if !ok || canonical != "azure" {
			t.Errorf("Resolve(%q) = %q, %v; want azure, true", name, canonical, ok)
		}
	}
	p, err := api.NewProvider("azure_openai", api.ProviderConfig{BaseURL: "https://x", APIKey: "k"})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if p.Name() != "azure" {
		t.Errorf("Name() = %q, want azure", p.Name())
	}
}

func TestStreamInterleavedError(t *testing.T) {
	body := strings.Join([]string{
		`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"}}]}`,
		"",
		`data: {"error":{"message":"server overloaded","type":"server_error"}}`,
		"",
	}, "\n")
	srv, _ := newServer(t, 200, "text/event-stream", body, nil)
	p := newProvider(t, api.ProviderConfig{BaseURL: srv.URL, APIKey: "test-key"})

	stream, err := p.Stream(context.Background(), &api.ChatRequest{Model: "dep"})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	if _, err := stream.Recv(); err != nil {
		t.Fatalf("first Recv: %v", err)
	}
	_, err = stream.Recv()
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("second Recv error = %v, want *api.Error", err)
	}
	if !strings.Contains(apiErr.Message, "server overloaded") {
		t.Errorf("message = %q", apiErr.Message)
	}
}
