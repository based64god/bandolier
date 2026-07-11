// Package copilot implements the GitHub Copilot adapter: the models a
// Copilot subscription serves through api.githubcopilot.com, authenticated by
// exchanging a GitHub OAuth access token for a short-lived Copilot session
// token (litellm's github_copilot provider). The chat surface is OpenAI
// chat/completions, so the openai adapter does the wire work; this package
// owns the token exchange and the editor headers the backend requires.
//
// The GitHub access token must be supplied (GITHUB_COPILOT_ACCESS_TOKEN, or
// litellm's token file); the interactive device-code login litellm can run is
// deliberately out of scope for a headless gateway.
package copilot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/providers/openai"
)

const (
	defaultAPIBase   = "https://api.githubcopilot.com"
	tokenExchangeURL = "https://api.github.com/copilot_internal/v2/token"

	// Editor identity headers, matching litellm's (which mirror VS Code's
	// Copilot Chat) — the backend rejects requests without a known editor.
	editorVersion       = "vscode/1.95.0"
	editorPluginVersion = "copilot-chat/0.26.7"
	userAgent           = "GitHubCopilotChat/0.26.7"
	githubAPIVersion    = "2025-04-01"

	// sessionExpirySkew refreshes the Copilot session token slightly early.
	sessionExpirySkew = 60 * time.Second
)

func init() {
	api.Register("github_copilot", func(cfg api.ProviderConfig) (api.Provider, error) {
		inner, err := openai.NewFactory(openai.Defaults{
			Name:                   "github_copilot",
			BaseURL:                defaultAPIBase,
			StreamOptionsSupported: true,
		})(cfg)
		if err != nil {
			return nil, err
		}
		return &Provider{inner: inner, auth: &authenticator{client: cfg.Client()}}, nil
	})
	api.RegisterAlias("copilot", "github_copilot")
}

// Provider adapts the GitHub Copilot chat backend.
type Provider struct {
	inner api.Provider
	auth  *authenticator
}

func (p *Provider) Name() string { return "github_copilot" }

func (p *Provider) prepare(ctx context.Context, req *api.ChatRequest) (*api.ChatRequest, error) {
	out := *req

	token := req.APIKey // a pre-minted Copilot session token
	apiBase := ""
	if token == "" {
		var err error
		token, apiBase, err = p.auth.sessionToken(ctx)
		if err != nil {
			return nil, err
		}
	}
	out.APIKey = token
	if out.BaseURL == "" && apiBase != "" {
		out.BaseURL = apiBase
	}

	headers := make(map[string]string, len(req.Headers)+8)
	headers["copilot-integration-id"] = "vscode-chat"
	headers["editor-version"] = editorVersion
	headers["editor-plugin-version"] = editorPluginVersion
	headers["User-Agent"] = userAgent
	headers["openai-intent"] = "conversation-panel"
	headers["x-github-api-version"] = githubAPIVersion
	headers["x-request-id"] = requestID()
	// The backend distinguishes user-initiated turns from agent loops.
	headers["X-Initiator"] = initiator(req.Messages)
	for k, v := range req.Headers {
		headers[k] = v
	}
	out.Headers = headers
	return &out, nil
}

// initiator reports whether the turn was user-initiated: "user" when the last
// message is a user or tool turn, else "agent" (litellm's rule).
func initiator(messages []api.Message) string {
	if len(messages) == 0 {
		return "agent"
	}
	switch messages[len(messages)-1].Role {
	case "user", "tool":
		return "user"
	default:
		return "agent"
	}
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	wire, err := p.prepare(ctx, req)
	if err != nil {
		return nil, err
	}
	return p.inner.Complete(ctx, wire)
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	wire, err := p.prepare(ctx, req)
	if err != nil {
		return nil, err
	}
	return p.inner.Stream(ctx, wire)
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("github_copilot", "embeddings")
}

// ── authentication ───────────────────────────────────────────────────────────

// authenticator exchanges a GitHub OAuth access token for the short-lived
// Copilot session token (and the account's API endpoint), caching it until
// expiry.
type authenticator struct {
	client *http.Client

	// exchangeURL is overridable for tests.
	exchangeURL string

	mu        sync.Mutex
	token     string
	apiBase   string
	expiresAt time.Time
}

// githubToken resolves the long-lived GitHub OAuth token: env first, then
// litellm's token file. GITHUB_TOKEN is deliberately NOT consulted — in CI
// and agent pods it is a repo-scoped token that cannot mint Copilot sessions.
func githubToken() (string, error) {
	for _, env := range []string{"GITHUB_COPILOT_ACCESS_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_COPILOT_TOKEN"} {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	dir := os.Getenv("GITHUB_COPILOT_TOKEN_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			home = "/root"
		}
		dir = filepath.Join(home, ".config", "litellm", "github_copilot")
	}
	name := os.Getenv("GITHUB_COPILOT_ACCESS_TOKEN_FILE")
	if name == "" {
		name = "access-token"
	}
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err == nil && len(strings.TrimSpace(string(b))) > 0 {
		return strings.TrimSpace(string(b)), nil
	}
	return "", &api.Error{
		Type: api.ErrAuthentication, StatusCode: 401, Provider: "github_copilot",
		Message: "no GitHub Copilot credentials: set GITHUB_COPILOT_ACCESS_TOKEN (a GitHub OAuth token with Copilot access) or provide " + filepath.Join(dir, name),
	}
}

// sessionToken returns a valid Copilot session token and the account's API
// base, exchanging the GitHub token when the cached session is expired.
func (a *authenticator) sessionToken(ctx context.Context) (token, apiBase string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && time.Now().Before(a.expiresAt.Add(-sessionExpirySkew)) {
		return a.token, a.apiBase, nil
	}

	gh, err := githubToken()
	if err != nil {
		return "", "", err
	}

	exchangeAt := a.exchangeURL
	if exchangeAt == "" {
		exchangeAt = os.Getenv("GITHUB_COPILOT_API_KEY_URL")
	}
	if exchangeAt == "" {
		exchangeAt = tokenExchangeURL
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, exchangeAt, nil)
	if err != nil {
		return "", "", api.WrapTransport("github_copilot", "", err)
	}
	httpReq.Header.Set("Authorization", "token "+gh)
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("editor-version", editorVersion)
	httpReq.Header.Set("editor-plugin-version", editorPluginVersion)
	httpReq.Header.Set("User-Agent", userAgent)

	resp, err := a.client.Do(httpReq)
	if err != nil {
		return "", "", api.WrapTransport("github_copilot", "", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return "", "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: resp.StatusCode, Provider: "github_copilot",
			Message: fmt.Sprintf("Copilot token exchange failed: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))),
		}
	}

	var out struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"`
		Endpoints struct {
			API string `json:"api"`
		} `json:"endpoints"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Token == "" {
		return "", "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "github_copilot",
			Message: "Copilot token exchange returned no token",
		}
	}
	a.token = out.Token
	a.apiBase = out.Endpoints.API
	if out.ExpiresAt > 0 {
		a.expiresAt = time.Unix(out.ExpiresAt, 0)
	} else {
		a.expiresAt = time.Now().Add(10 * time.Minute)
	}
	return a.token, a.apiBase, nil
}

// requestID mints the per-request x-request-id (UUID-shaped).
func requestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}
