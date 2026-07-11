package vertex

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

// clearVertexEnv isolates tests from any real Google credentials in the
// environment.
func clearVertexEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"VERTEXAI_PROJECT", "GOOGLE_CLOUD_PROJECT", "VERTEXAI_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_CREDENTIALS"} {
		t.Setenv(k, "")
	}
}

const minimalGeminiResponse = `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}`

func minimalRequest(model string) *api.ChatRequest {
	return &api.ChatRequest{
		Model:    model,
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}
}

func TestRegistryAliases(t *testing.T) {
	for _, alias := range []string{"vertex", "vertex_ai", "vertexai"} {
		got, ok := api.Resolve(alias)
		if !ok || got != "vertex" {
			t.Errorf("Resolve(%q) = %q, %v", alias, got, ok)
		}
	}
}

// TestServiceAccountFlow exercises the full OAuth path: credentials from
// inline JSON, token minted at the fake endpoint (once, then cached), project
// falling back to the service account's project_id.
func TestServiceAccountFlow(t *testing.T) {
	clearVertexEnv(t)
	_, pemKey := testKey(t)
	var hits int
	var assertion string
	tokenSrv := fakeTokenServer(t, &hits, &assertion)
	defer tokenSrv.Close()

	var c captured
	apiSrv := httptest.NewServer(captureHandler(t, &c, "application/json", minimalGeminiResponse))
	defer apiSrv.Close()

	p, err := api.NewProvider("vertex_ai", api.ProviderConfig{
		Extra: map[string]string{
			"credentials_json": testCredentials(t, pemKey, tokenSrv.URL),
			"token_url":        tokenSrv.URL,
			"api_endpoint":     apiSrv.URL,
		},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}

	for i := 0; i < 2; i++ {
		if _, err := p.Complete(context.Background(), minimalRequest("gemini-2.0-flash")); err != nil {
			t.Fatalf("Complete #%d: %v", i+1, err)
		}
	}
	if c.auth != "Bearer fake-token" {
		t.Errorf("Authorization = %q, want the minted token", c.auth)
	}
	if hits != 1 {
		t.Errorf("token endpoint hits = %d, want 1 (cached)", hits)
	}
	if !strings.Contains(c.path, "/projects/sa-project/") {
		t.Errorf("path = %s, want project from service-account project_id", c.path)
	}
	if !strings.Contains(c.path, "/locations/us-central1/") {
		t.Errorf("path = %s, want default location us-central1", c.path)
	}
}

// TestEnvFallbacks reads the project from VERTEXAI_PROJECT and the
// credentials from the file named by GOOGLE_APPLICATION_CREDENTIALS.
func TestEnvFallbacks(t *testing.T) {
	clearVertexEnv(t)
	_, pemKey := testKey(t)
	var hits int
	var assertion string
	tokenSrv := fakeTokenServer(t, &hits, &assertion)
	defer tokenSrv.Close()

	credFile := filepath.Join(t.TempDir(), "sa.json")
	if err := os.WriteFile(credFile, []byte(testCredentials(t, pemKey, tokenSrv.URL)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", credFile)
	t.Setenv("VERTEXAI_PROJECT", "env-proj")
	t.Setenv("VERTEXAI_LOCATION", "europe-west4")

	var c captured
	apiSrv := httptest.NewServer(captureHandler(t, &c, "application/json", minimalGeminiResponse))
	defer apiSrv.Close()

	p, err := api.NewProvider("vertex", api.ProviderConfig{
		Extra: map[string]string{"token_url": tokenSrv.URL, "api_endpoint": apiSrv.URL},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, err := p.Complete(context.Background(), minimalRequest("gemini-2.0-flash")); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !strings.Contains(c.path, "/projects/env-proj/locations/europe-west4/") {
		t.Errorf("path = %s, want env project and location", c.path)
	}
	if c.auth != "Bearer fake-token" {
		t.Errorf("Authorization = %q", c.auth)
	}
}

// TestInlineCredentialsFromEnv feeds the service-account key as raw JSON in
// GOOGLE_APPLICATION_CREDENTIALS_JSON — no file, no Extra — which is how an
// in-process proxy hands vertex its credentials.
func TestInlineCredentialsFromEnv(t *testing.T) {
	clearVertexEnv(t)
	_, pemKey := testKey(t)
	var hits int
	var assertion string
	tokenSrv := fakeTokenServer(t, &hits, &assertion)
	defer tokenSrv.Close()

	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS_JSON", testCredentials(t, pemKey, tokenSrv.URL))
	t.Setenv("VERTEXAI_PROJECT", "env-proj")

	var c captured
	apiSrv := httptest.NewServer(captureHandler(t, &c, "application/json", minimalGeminiResponse))
	defer apiSrv.Close()

	p, err := api.NewProvider("vertex", api.ProviderConfig{
		Extra: map[string]string{"token_url": tokenSrv.URL, "api_endpoint": apiSrv.URL},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, err := p.Complete(context.Background(), minimalRequest("gemini-2.0-flash")); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !strings.Contains(c.path, "/projects/env-proj/") {
		t.Errorf("path = %s, want env project", c.path)
	}
	if c.auth != "Bearer fake-token" {
		t.Errorf("Authorization = %q, want the minted token", c.auth)
	}
}

func TestBaseURLOverride(t *testing.T) {
	clearVertexEnv(t)
	var c captured
	srv := httptest.NewServer(captureHandler(t, &c, "application/json", minimalGeminiResponse))
	defer srv.Close()

	// cfg.BaseURL (no api_endpoint) must redirect the API host too.
	p, err := api.NewProvider("vertex", api.ProviderConfig{
		APIKey:  "test-key",
		BaseURL: srv.URL,
		Extra:   map[string]string{"project": "proj-2"},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, err := p.Complete(context.Background(), minimalRequest("gemini-2.0-flash")); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !strings.HasPrefix(c.path, "/v1/projects/proj-2/locations/us-central1/") {
		t.Errorf("path = %s", c.path)
	}
}

func TestDefaultHosts(t *testing.T) {
	clearVertexEnv(t)
	regional := &Provider{cfg: api.ProviderConfig{Extra: map[string]string{"project": "p", "location": "europe-west4"}}}
	url, err := regional.modelURL("", "google", "gemini-2.0-flash", "generateContent")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/publishers/google/models/gemini-2.0-flash:generateContent"
	if url != want {
		t.Errorf("url = %s\nwant %s", url, want)
	}

	global := &Provider{cfg: api.ProviderConfig{Extra: map[string]string{"project": "p", "location": "global"}}}
	url, err = global.modelURL("", "google", "gemini-2.0-flash", "generateContent")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "https://aiplatform.googleapis.com/v1/projects/p/locations/global/") {
		t.Errorf("global url = %s", url)
	}
}

func TestMissingProject(t *testing.T) {
	clearVertexEnv(t)
	p, err := api.NewProvider("vertex", api.ProviderConfig{APIKey: "test-key"})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	_, err = p.Complete(context.Background(), minimalRequest("gemini-2.0-flash"))
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("err = %v, want authentication_error", err)
	}
	if !strings.Contains(apiErr.Message, "project") {
		t.Errorf("message %q should mention the project setting", apiErr.Message)
	}
}

func TestMissingCredentials(t *testing.T) {
	clearVertexEnv(t)
	p, err := api.NewProvider("vertex", api.ProviderConfig{
		Extra: map[string]string{"project": "proj-1"},
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	_, err = p.Complete(context.Background(), minimalRequest("gemini-2.0-flash"))
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("err = %v, want authentication_error", err)
	}
	if !strings.Contains(apiErr.Message, "credentials_json") {
		t.Errorf("message %q should mention credentials_json", apiErr.Message)
	}
}
