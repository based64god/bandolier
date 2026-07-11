package bedrock

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

func ptr[T any](v T) *T { return &v }

// clearAWSEnv makes credential resolution deterministic regardless of the
// host's AWS environment.
func clearAWSEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"} {
		t.Setenv(k, "")
	}
}

func newTestProvider(t *testing.T, baseURL string) api.Provider {
	t.Helper()
	clearAWSEnv(t)
	p, err := api.NewProvider("bedrock", api.ProviderConfig{
		BaseURL: baseURL,
		Extra: map[string]string{
			"access_key_id":     "AKIDEXAMPLE",
			"secret_access_key": "test-secret",
			"session_token":     "test-session",
			"region":            "us-west-2",
		},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	return p
}

const minimalConverseResponse = `{"output":{"message":{"role":"assistant","content":[{"text":"ok"}]}},` +
	`"stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}`

func TestCompleteRequestTranslation(t *testing.T) {
	var (
		gotPath   string
		gotHeader http.Header
		gotBody   []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotHeader = r.Header.Clone()
		gotBody, _ = io.ReadAll(r.Body)
		w.Write([]byte(minimalConverseResponse))
	}))
	defer srv.Close()

	p := newTestProvider(t, srv.URL)
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be terse")},
			{Role: "user", Content: api.PartsContent(
				api.TextPart("what is this?"),
				api.ImagePart("data:image/png;base64,aWNvbg=="),
			)},
			{Role: "assistant", Content: api.TextContent("checking"), ToolCalls: []api.ToolCall{{
				ID: "call_1", Type: "function",
				Function: api.ToolCallFunction{Name: "lookup", Arguments: `{"q":"x"}`},
			}}},
			{Role: "tool", ToolCallID: "call_1", Content: api.TextContent("42")},
			{Role: "user", Content: api.TextContent("thanks, again?")},
		},
		Temperature: ptr(0.5),
		TopP:        ptr(0.9),
		MaxTokens:   ptr(256),
		Stop:        api.StringOrSlice{"END"},
		Tools: []api.Tool{{Type: "function", Function: api.ToolFunction{
			Name:        "lookup",
			Description: "look things up",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`),
		}}},
		ToolChoice: api.ToolChoiceFunction("lookup"),
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	// Model id escaped in the path (":" → %3A) and signed headers present.
	if want := "/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse"; gotPath != want {
		t.Errorf("path = %q, want %q", gotPath, want)
	}
	if !regexp.MustCompile(`^\d{8}T\d{6}Z$`).MatchString(gotHeader.Get("X-Amz-Date")) {
		t.Errorf("X-Amz-Date = %q", gotHeader.Get("X-Amz-Date"))
	}
	if gotHeader.Get("X-Amz-Security-Token") != "test-session" {
		t.Errorf("X-Amz-Security-Token = %q", gotHeader.Get("X-Amz-Security-Token"))
	}
	authPattern := `^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\d{8}/us-west-2/bedrock/aws4_request, ` +
		`SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$`
	if auth := gotHeader.Get("Authorization"); !regexp.MustCompile(authPattern).MatchString(auth) {
		t.Errorf("Authorization %q does not match %s", auth, authPattern)
	}

	// system hoisted, roles merged (toolResult + trailing user text), images
	// and toolUse/toolResult translated, inference and tool config populated.
	wantBody := `{
	  "messages": [
	    {"role":"user","content":[{"text":"what is this?"},{"image":{"format":"png","source":{"bytes":"aWNvbg=="}}}]},
	    {"role":"assistant","content":[{"text":"checking"},{"toolUse":{"toolUseId":"call_1","name":"lookup","input":{"q":"x"}}}]},
	    {"role":"user","content":[{"toolResult":{"toolUseId":"call_1","content":[{"text":"42"}]}},{"text":"thanks, again?"}]}
	  ],
	  "system":[{"text":"be terse"}],
	  "inferenceConfig":{"maxTokens":256,"temperature":0.5,"topP":0.9,"stopSequences":["END"]},
	  "toolConfig":{
	    "tools":[{"toolSpec":{"name":"lookup","description":"look things up",
	      "inputSchema":{"json":{"type":"object","properties":{"q":{"type":"string"}}}}}}],
	    "toolChoice":{"tool":{"name":"lookup"}}
	  }
	}`
	var got, want any
	if err := json.Unmarshal(gotBody, &got); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	if err := json.Unmarshal([]byte(wantBody), &want); err != nil {
		t.Fatalf("decode want body: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wire body mismatch:\n got %s\nwant %s", gotBody, mustCompact(t, wantBody))
	}
}

func mustCompact(t *testing.T, s string) string {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func TestCompleteResponseTranslation(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.Write([]byte(`{
		  "output":{"message":{"role":"assistant","content":[
		    {"text":"I'll check."},
		    {"toolUse":{"toolUseId":"tooluse_abc","name":"lookup","input":{"q":"x"}}}
		  ]}},
		  "stopReason":"tool_use",
		  "usage":{"inputTokens":10,"outputTokens":25,"totalTokens":35,
		    "cacheReadInputTokens":100,"cacheWriteInputTokens":7}
		}`))
	}))
	defer srv.Close()

	p := newTestProvider(t, srv.URL)
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	// No caller limit → the Converse-required default is applied.
	var sent struct {
		InferenceConfig struct {
			MaxTokens int `json:"maxTokens"`
		} `json:"inferenceConfig"`
	}
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.InferenceConfig.MaxTokens != defaultMaxTokens {
		t.Errorf("default maxTokens = %d, want %d", sent.InferenceConfig.MaxTokens, defaultMaxTokens)
	}

	if resp.Provider != "bedrock" || resp.Object != "chat.completion" || !strings.HasPrefix(resp.ID, "chatcmpl-") {
		t.Errorf("envelope = %+v", resp)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("choices = %d", len(resp.Choices))
	}
	choice := resp.Choices[0]
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q, want tool_calls", choice.FinishReason)
	}
	if got := choice.Message.Content.AsText(); got != "I'll check." {
		t.Errorf("content = %q", got)
	}
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d", len(choice.Message.ToolCalls))
	}
	tc := choice.Message.ToolCalls[0]
	if tc.ID != "tooluse_abc" || tc.Type != "function" || tc.Function.Name != "lookup" || tc.Function.Arguments != `{"q":"x"}` {
		t.Errorf("tool call = %+v", tc)
	}

	// Cache read/write folded into prompt tokens, split kept in details.
	u := resp.Usage
	if u == nil {
		t.Fatal("usage missing")
	}
	if u.PromptTokens != 117 || u.CompletionTokens != 25 || u.TotalTokens != 35 {
		t.Errorf("usage = %+v", u)
	}
	if u.PromptTokensDetails == nil ||
		u.PromptTokensDetails.CachedTokens != 100 || u.PromptTokensDetails.CacheCreationTokens != 7 {
		t.Errorf("prompt token details = %+v", u.PromptTokensDetails)
	}
}

// TestToolChoiceTranslation covers the remaining tool_choice arms directly.
func TestToolChoiceTranslation(t *testing.T) {
	base := &api.ChatRequest{
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		Tools:    []api.Tool{{Type: "function", Function: api.ToolFunction{Name: "f"}}},
	}
	cases := []struct {
		choice *api.ToolChoice
		want   string // toolChoice JSON, "" = field absent, "drop" = no toolConfig
	}{
		{nil, ""},
		{api.ToolChoiceAuto(), `{"auto":{}}`},
		{api.ToolChoiceRequired(), `{"any":{}}`},
		{api.ToolChoiceFunction("f"), `{"tool":{"name":"f"}}`},
		{api.ToolChoiceNone(), "drop"},
	}
	for _, c := range cases {
		req := *base
		req.ToolChoice = c.choice
		cr := translateRequest(&req)
		if c.want == "drop" {
			if cr.ToolConfig != nil {
				t.Errorf("tool_choice none: toolConfig should be dropped, got %+v", cr.ToolConfig)
			}
			continue
		}
		if cr.ToolConfig == nil {
			t.Errorf("choice %+v: toolConfig missing", c.choice)
			continue
		}
		if c.want == "" {
			if cr.ToolConfig.ToolChoice != nil {
				t.Errorf("nil choice: toolChoice should be omitted, got %+v", cr.ToolConfig.ToolChoice)
			}
			continue
		}
		got, _ := json.Marshal(cr.ToolConfig.ToolChoice)
		if string(got) != c.want {
			t.Errorf("choice %+v: toolChoice = %s, want %s", c.choice, got, c.want)
		}
	}
}

func TestStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.EscapedPath(), "/converse-stream") {
			t.Errorf("stream path = %q", r.URL.EscapedPath())
		}
		w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
		for _, f := range [][]byte{
			eventFrame("messageStart", `{"role":"assistant"}`),
			eventFrame("contentBlockDelta", `{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"thinking..."}}}`),
			eventFrame("contentBlockDelta", `{"contentBlockIndex":0,"delta":{"text":"Hello"}}`),
			eventFrame("contentBlockDelta", `{"contentBlockIndex":0,"delta":{"text":" world"}}`),
			eventFrame("contentBlockStop", `{"contentBlockIndex":0}`),
			eventFrame("contentBlockStart", `{"contentBlockIndex":1,"start":{"toolUse":{"toolUseId":"tooluse_1","name":"lookup"}}}`),
			eventFrame("contentBlockDelta", `{"contentBlockIndex":1,"delta":{"toolUse":{"input":"{\"q\":"}}}`),
			eventFrame("contentBlockDelta", `{"contentBlockIndex":1,"delta":{"toolUse":{"input":"\"x\"}"}}}`),
			eventFrame("contentBlockStop", `{"contentBlockIndex":1}`),
			eventFrame("messageStop", `{"stopReason":"tool_use"}`),
			eventFrame("metadata", `{"usage":{"inputTokens":5,"outputTokens":9,"totalTokens":14},"metrics":{"latencyMs":800}}`),
		} {
			w.Write(f)
		}
	}))
	defer srv.Close()

	p := newTestProvider(t, srv.URL)
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "anthropic.claude-sonnet-4-5-20250929-v1:0",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	var chunks []*api.ChatChunk
	for {
		c, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		chunks = append(chunks, c)
	}
	// contentBlockStop frames surface nothing: 1 role + 1 reasoning + 2 text
	// + 1 tool open + 2 tool args + 1 stop + 1 usage.
	if len(chunks) != 9 {
		t.Fatalf("chunks = %d, want 9", len(chunks))
	}
	for _, c := range chunks {
		if c.ID != chunks[0].ID || !strings.HasPrefix(c.ID, "chatcmpl-") || c.Object != "chat.completion.chunk" {
			t.Errorf("chunk envelope = %+v", c)
		}
	}
	if chunks[0].Choices[0].Delta.Role != "assistant" {
		t.Errorf("first chunk = %+v", chunks[0].Choices[0])
	}
	// Tool open chunk carries the sequential OpenAI index (first tool → 0),
	// not Bedrock's contentBlockIndex (1).
	open := chunks[4].Choices[0].Delta.ToolCalls
	if len(open) != 1 || open[0].Index == nil || *open[0].Index != 0 ||
		open[0].ID != "tooluse_1" || open[0].Function.Name != "lookup" {
		t.Errorf("tool open chunk = %+v", open)
	}
	if usage := chunks[8]; len(usage.Choices) != 0 || usage.Usage == nil {
		t.Errorf("usage chunk = %+v", usage)
	}

	acc := api.NewStreamAccumulator()
	for _, c := range chunks {
		acc.Add(c)
	}
	final := acc.Response()
	msg := final.Choices[0].Message
	if got := msg.Content.AsText(); got != "Hello world" {
		t.Errorf("content = %q", got)
	}
	if msg.ReasoningContent != "thinking..." {
		t.Errorf("reasoning = %q", msg.ReasoningContent)
	}
	if len(msg.ToolCalls) != 1 || msg.ToolCalls[0].ID != "tooluse_1" ||
		msg.ToolCalls[0].Function.Name != "lookup" || msg.ToolCalls[0].Function.Arguments != `{"q":"x"}` {
		t.Errorf("tool calls = %+v", msg.ToolCalls)
	}
	if final.Choices[0].FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q", final.Choices[0].FinishReason)
	}
	if final.Usage == nil || final.Usage.PromptTokens != 5 || final.Usage.CompletionTokens != 9 || final.Usage.TotalTokens != 14 {
		t.Errorf("usage = %+v", final.Usage)
	}
}

func TestStreamException(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(eventFrame("contentBlockDelta", `{"contentBlockIndex":0,"delta":{"text":"partial"}}`))
		w.Write(encodeFrame([][2]string{
			{":message-type", "exception"},
			{":exception-type", "throttlingException"},
			{":content-type", "application/json"},
		}, []byte(`{"message":"Rate exceeded"}`)))
	}))
	defer srv.Close()

	p := newTestProvider(t, srv.URL)
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "anthropic.claude-sonnet-4-5-20250929-v1:0",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer stream.Close()

	if c, err := stream.Recv(); err != nil || c.Choices[0].Delta.Content != "partial" {
		t.Fatalf("first chunk = %+v, %v", c, err)
	}
	_, err = stream.Recv()
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("want *api.Error, got %v", err)
	}
	if apiErr.Type != api.ErrRateLimit || apiErr.StatusCode != 429 || apiErr.Message != "Rate exceeded" {
		t.Errorf("error = %+v", apiErr)
	}
}

func TestErrorMapping(t *testing.T) {
	cases := []struct {
		status     int
		body       string
		retryAfter string
		wantType   api.ErrorType
		wantRetry  time.Duration
	}{
		{400, `{"message":"1 validation error detected"}`, "", api.ErrBadRequest, 0},
		{429, `{"message":"Too many requests"}`, "2", api.ErrRateLimit, 2 * time.Second},
		{503, `{"message":"Model is overloaded"}`, "", api.ErrUnavailable, 0},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if c.retryAfter != "" {
				w.Header().Set("Retry-After", c.retryAfter)
			}
			w.WriteHeader(c.status)
			w.Write([]byte(c.body))
		}))
		p := newTestProvider(t, srv.URL)
		_, err := p.Complete(context.Background(), &api.ChatRequest{
			Model:    "anthropic.claude-sonnet-4-5-20250929-v1:0",
			Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		})
		srv.Close()

		apiErr, ok := api.AsError(err)
		if !ok {
			t.Fatalf("status %d: want *api.Error, got %v", c.status, err)
		}
		if apiErr.Type != c.wantType || apiErr.StatusCode != c.status || apiErr.RetryAfter != c.wantRetry {
			t.Errorf("status %d: error = %+v, want type=%s retry=%s", c.status, apiErr, c.wantType, c.wantRetry)
		}
		if apiErr.Provider != "bedrock" {
			t.Errorf("status %d: provider = %q", c.status, apiErr.Provider)
		}
	}
}

func TestMissingCredentialsAndRegion(t *testing.T) {
	clearAWSEnv(t)
	req := &api.ChatRequest{Model: "m", Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}}}

	p, err := api.NewProvider("bedrock", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.Complete(context.Background(), req)
	if apiErr, ok := api.AsError(err); !ok || apiErr.Type != api.ErrAuthentication ||
		!strings.Contains(apiErr.Message, "AWS_ACCESS_KEY_ID") {
		t.Errorf("missing credentials error = %v", err)
	}

	p, err = api.NewProvider("bedrock", api.ProviderConfig{Extra: map[string]string{
		"access_key_id": "AKID", "secret_access_key": "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.Complete(context.Background(), req)
	if apiErr, ok := api.AsError(err); !ok || apiErr.Type != api.ErrBadRequest ||
		!strings.Contains(apiErr.Message, "AWS_REGION") {
		t.Errorf("missing region error = %v", err)
	}
}

// TestEnvCredentialFallback exercises the env path end-to-end: everything
// resolved from AWS_* variables, region visible in the credential scope.
func TestEnvCredentialFallback(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Write([]byte(minimalConverseResponse))
	}))
	defer srv.Close()

	t.Setenv("AWS_ACCESS_KEY_ID", "AKIDENV")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "env-secret")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_REGION", "eu-central-1")

	p, err := api.NewProvider("bedrock", api.ProviderConfig{BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "anthropic.claude-sonnet-4-5-20250929-v1:0",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !strings.Contains(gotAuth, "Credential=AKIDENV/") || !strings.Contains(gotAuth, "/eu-central-1/bedrock/aws4_request") {
		t.Errorf("Authorization = %q", gotAuth)
	}
	// No session token → not in the signed header list.
	if strings.Contains(gotAuth, "x-amz-security-token") {
		t.Errorf("unexpected security token in %q", gotAuth)
	}
}

func TestEmbedNotSupported(t *testing.T) {
	p := newTestProvider(t, "http://unused")
	_, err := p.Embed(context.Background(), &api.EmbeddingRequest{Model: "m"})
	if apiErr, ok := api.AsError(err); !ok || apiErr.Type != api.ErrNotSupported {
		t.Errorf("Embed error = %v", err)
	}
}
