// Package gigachat implements the Sber GigaChat adapter. The chat surface is
// OpenAI chat/completions (the openai adapter does the wire work); auth is
// Sber's OAuth: a base64 authorization key is exchanged at the NGW endpoint
// for a ~30-minute access token. A pre-minted token (GIGACHAT_ACCESS_TOKEN)
// skips the exchange.
//
// Note: Sber's TLS chain is signed by the Russian Trusted Root CA, which is
// absent from standard trust stores — supply an http.Client with the CA via
// ProviderConfig.HTTPClient (or install the CA) to reach the real endpoints.
package gigachat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/providers/openai"
)

const (
	defaultAPIBase = "https://gigachat.devices.sberbank.ru/api/v1"
	defaultAuthURL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
	defaultScope   = "GIGACHAT_API_PERS"

	tokenExpirySkew = 60 * time.Second
)

func init() {
	api.Register("gigachat", func(cfg api.ProviderConfig) (api.Provider, error) {
		inner, err := openai.NewFactory(openai.Defaults{
			Name:        "gigachat",
			BaseURL:     defaultAPIBase,
			BaseURLEnvs: []string{"GIGACHAT_API_BASE"},
		})(cfg)
		if err != nil {
			return nil, err
		}
		return &Provider{inner: inner, auth: &authenticator{client: cfg.Client(), credentials: cfg.APIKey}}, nil
	})
}

// Provider adapts Sber GigaChat.
type Provider struct {
	inner api.Provider
	auth  *authenticator
}

func (p *Provider) Name() string { return "gigachat" }

func (p *Provider) prepare(ctx context.Context, req *api.ChatRequest) (*api.ChatRequest, error) {
	out := *req
	// A per-request key is the authorization key (litellm's api_key
	// semantics) — it feeds the OAuth exchange, never the wire. A pre-minted
	// bearer can be supplied via GIGACHAT_ACCESS_TOKEN.
	token, err := p.auth.accessToken(ctx, req.APIKey)
	if err != nil {
		return nil, err
	}
	out.APIKey = token
	return &out, nil
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
	return nil, api.NotSupported("gigachat", "embeddings")
}

// ── OAuth ────────────────────────────────────────────────────────────────────

// authenticator exchanges the GigaChat authorization key (a base64 client
// credential from the developer portal) for an access token, caching until
// its expiry.
type authenticator struct {
	client      *http.Client
	credentials string // from ProviderConfig.APIKey; env fallback below
	authURL     string // overridable for tests

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func (a *authenticator) accessToken(ctx context.Context, credsOverride string) (string, error) {
	if v := os.Getenv("GIGACHAT_ACCESS_TOKEN"); v != "" {
		return v, nil
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && time.Now().Before(a.expiresAt.Add(-tokenExpirySkew)) {
		return a.token, nil
	}

	creds := credsOverride
	if creds == "" {
		creds = a.credentials
	}
	if creds == "" {
		for _, env := range []string{"GIGACHAT_CREDENTIALS", "GIGACHAT_API_KEY", "GIGACHAT_AUTH_KEY"} {
			if v := os.Getenv(env); v != "" {
				creds = v
				break
			}
		}
	}
	if creds == "" {
		return "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "gigachat",
			Message: "no GigaChat credentials: set GIGACHAT_CREDENTIALS (authorization key) or GIGACHAT_ACCESS_TOKEN (pre-minted token)",
		}
	}

	scope := os.Getenv("GIGACHAT_SCOPE")
	if scope == "" {
		scope = defaultScope
	}
	authURL := a.authURL
	if authURL == "" {
		authURL = os.Getenv("GIGACHAT_AUTH_URL")
	}
	if authURL == "" {
		authURL = defaultAuthURL
	}

	form := url.Values{"scope": {scope}}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", api.WrapTransport("gigachat", "", err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Authorization", "Basic "+creds)
	httpReq.Header.Set("RqUID", rqUID())

	resp, err := a.client.Do(httpReq)
	if err != nil {
		return "", api.WrapTransport("gigachat", "", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: resp.StatusCode, Provider: "gigachat",
			Message: fmt.Sprintf("GigaChat OAuth failed: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))),
		}
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresAt   int64  `json:"expires_at"` // unix millis
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "gigachat",
			Message: "GigaChat OAuth returned no access_token",
		}
	}
	a.token = out.AccessToken
	if out.ExpiresAt > 0 {
		a.expiresAt = time.UnixMilli(out.ExpiresAt)
	} else {
		a.expiresAt = time.Now().Add(25 * time.Minute)
	}
	return a.token, nil
}

// rqUID mints the RqUID header Sber's OAuth endpoint requires (UUID-shaped).
func rqUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}
