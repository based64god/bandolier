package watsonx

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

func clearWatsonxEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"WATSONX_URL", "WATSONX_API_BASE", "WX_URL", "WATSONX_TOKEN", "WATSONX_APIKEY",
		"WATSONX_API_KEY", "WX_API_KEY", "WATSONX_PROJECT_ID", "WX_PROJECT_ID", "PROJECT_ID",
		"WATSONX_SPACE_ID", "WX_SPACE_ID", "WATSONX_API_VERSION", "WATSONX_IAM_URL",
	} {
		t.Setenv(k, "")
	}
}

func TestWatsonxCompleteExchangesIAMAndTranslates(t *testing.T) {
	clearWatsonxEnv(t)
	var iamCalls int
	iam := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		iamCalls++
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "urn:ibm:params:oauth:grant-type:apikey" || r.Form.Get("apikey") != "wx-key" {
			t.Errorf("unexpected IAM form: %v", r.Form)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "iam-tok", "expires_in": 3600})
	}))
	defer iam.Close()

	var gotURL string
	var gotBody map[string]any
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		if got := r.Header.Get("Authorization"); got != "Bearer iam-tok" {
			t.Errorf("Authorization = %q", got)
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "wx-1", "model_id": "ibm/granite-13b-chat-v2", "created": 1,
			"choices": []map[string]any{{"index": 0, "message": map[string]any{"role": "assistant", "content": "hi from watsonx"}, "finish_reason": "stop"}},
			"usage":   map[string]int{"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7},
		})
	}))
	defer backend.Close()

	t.Setenv("WATSONX_URL", backend.URL)
	t.Setenv("WATSONX_APIKEY", "wx-key")
	t.Setenv("WATSONX_PROJECT_ID", "proj-123")

	pv, err := api.NewProvider("watsonx", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	p := pv.(*Provider)
	p.auth.iamURL = iam.URL

	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "ibm/granite-13b-chat-v2",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Second call must reuse the cached IAM token.
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "ibm/granite-13b-chat-v2",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("again")}},
	}); err != nil {
		t.Fatal(err)
	}

	if gotURL != "/ml/v1/text/chat?version="+defaultAPIVersion {
		t.Errorf("url = %q", gotURL)
	}
	if gotBody["model_id"] != "ibm/granite-13b-chat-v2" || gotBody["project_id"] != "proj-123" {
		t.Errorf("body ids = model_id:%v project_id:%v", gotBody["model_id"], gotBody["project_id"])
	}
	if _, present := gotBody["model"]; present {
		t.Error("OpenAI model field must not reach the watsonx wire")
	}
	if iamCalls != 1 {
		t.Errorf("IAM calls = %d, want 1 (token cached)", iamCalls)
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from watsonx" {
		t.Errorf("content = %q", got)
	}
	if resp.Model != "ibm/granite-13b-chat-v2" || resp.Usage == nil || resp.Usage.TotalTokens != 7 {
		t.Errorf("model/usage = %q %+v", resp.Model, resp.Usage)
	}
}

func TestWatsonxDeploymentModelAndStream(t *testing.T) {
	clearWatsonxEnv(t)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ml/v1/deployments/dep-9/text/chat_stream" {
			t.Errorf("path = %q", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, k := range []string{"model_id", "project_id", "space_id"} {
			if _, present := body[k]; present {
				t.Errorf("%s must be absent for deployment models", k)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"model_id\":\"dep\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer backend.Close()

	t.Setenv("WATSONX_URL", backend.URL)
	t.Setenv("WATSONX_TOKEN", "pre-minted")

	p, err := api.NewProvider("watsonx", api.ProviderConfig{})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "deployment/dep-9",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	chunk, err := stream.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if chunk.Choices[0].Delta.Content != "ok" {
		t.Errorf("delta = %+v", chunk.Choices[0].Delta)
	}
	if chunk.Model != "dep" {
		t.Errorf("model = %q, want carried from model_id", chunk.Model)
	}
	if _, err := stream.Recv(); err != io.EOF {
		t.Errorf("want EOF after [DONE], got %v", err)
	}
}

func TestWatsonxMissingProject(t *testing.T) {
	clearWatsonxEnv(t)
	t.Setenv("WATSONX_URL", "http://127.0.0.1:0")
	t.Setenv("WATSONX_TOKEN", "tok")
	p, _ := api.NewProvider("watsonx", api.ProviderConfig{})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "ibm/granite-13b-chat-v2",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrBadRequest {
		t.Fatalf("err = %v, want a bad-request api.Error about the project", err)
	}
}
