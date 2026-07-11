package snowflake

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/based64god/gollm/api"
)

const completion = `{"id":"sf-1","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}`

func run(t *testing.T, apiKey string) (path, auth, tokenType string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		auth = r.Header.Get("Authorization")
		tokenType = r.Header.Get("X-Snowflake-Authorization-Token-Type")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, completion)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("SNOWFLAKE_API_BASE", srv.URL+"/api/v2")
	t.Setenv("SNOWFLAKE_ACCOUNT_ID", "")
	p, err := api.NewProvider("snowflake", api.ProviderConfig{APIKey: apiKey})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "mistral-large2",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	}); err != nil {
		t.Fatal(err)
	}
	return path, auth, tokenType
}

func TestSnowflakeJWT(t *testing.T) {
	path, auth, tokenType := run(t, "jwt-abc")
	if path != "/api/v2/cortex/v1/chat/completions" {
		t.Errorf("path = %q", path)
	}
	if auth != "Bearer jwt-abc" {
		t.Errorf("Authorization = %q", auth)
	}
	if tokenType != "KEYPAIR_JWT" {
		t.Errorf("token type = %q, want KEYPAIR_JWT", tokenType)
	}
}

func TestSnowflakePAT(t *testing.T) {
	// litellm's convention: a "pat/" prefix marks a programmatic access token.
	_, auth, tokenType := run(t, "pat/pat-xyz")
	if auth != "Bearer pat-xyz" {
		t.Errorf("Authorization = %q, want the prefix stripped", auth)
	}
	if tokenType != "PROGRAMMATIC_ACCESS_TOKEN" {
		t.Errorf("token type = %q, want PROGRAMMATIC_ACCESS_TOKEN", tokenType)
	}
}

func TestSnowflakeAccountIDBase(t *testing.T) {
	t.Setenv("SNOWFLAKE_API_BASE", "")
	t.Setenv("SNOWFLAKE_ACCOUNT_ID", "my-acct")
	pv, _ := api.NewProvider("snowflake", api.ProviderConfig{})
	base, err := pv.(*Provider).base("")
	if err != nil {
		t.Fatal(err)
	}
	if base != "https://my-acct.snowflakecomputing.com/api/v2/cortex/v1" {
		t.Errorf("base = %q", base)
	}
}

func TestSnowflakeMissingEndpoint(t *testing.T) {
	t.Setenv("SNOWFLAKE_API_BASE", "")
	t.Setenv("SNOWFLAKE_ACCOUNT_ID", "")
	p, _ := api.NewProvider("snowflake", api.ProviderConfig{APIKey: "k"})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "m",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrBadRequest {
		t.Fatalf("err = %v, want bad-request api.Error", err)
	}
}
