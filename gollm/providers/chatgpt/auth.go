package chatgpt

import (
	"bytes"
	"context"
	"encoding/base64"
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
)

// OAuth constants, derived from openai/codex (the same values litellm's
// chatgpt provider uses).
const (
	oauthTokenURL = "https://auth.openai.com/oauth/token"
	oauthClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

	// tokenExpirySkew refreshes slightly early so a token never expires
	// mid-request.
	tokenExpirySkew = 60 * time.Second
)

// tokens is the credential set from a ChatGPT-subscription login.
type tokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	AccountID    string `json:"account_id"`
}

// authFile is the on-disk auth.json in either known shape: the Codex CLI's
// (`codex login`), which nests the credential set under "tokens", or
// litellm's flat form. Exactly one of the two carries data.
type authFile struct {
	// Codex CLI shape.
	Tokens *tokens `json:"tokens,omitempty"`
	// Flat (litellm) shape.
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
	AccountID    string `json:"account_id,omitempty"`
}

// creds extracts the credential set regardless of shape.
func (f authFile) creds() tokens {
	if f.Tokens != nil {
		return *f.Tokens
	}
	return tokens{
		AccessToken:  f.AccessToken,
		RefreshToken: f.RefreshToken,
		IDToken:      f.IDToken,
		AccountID:    f.AccountID,
	}
}

// authenticator resolves and refreshes the ChatGPT OAuth access token. It is
// loaded once from an inline JSON document or an auth.json file, refreshed
// in memory when expired, and — when file-backed — persisted back
// best-effort so a rotated refresh token survives the process.
type authenticator struct {
	client   *http.Client
	tokenURL string

	mu   sync.Mutex
	tok  tokens
	path string // "" when the source was inline JSON (nothing to persist)
	// codexShape records which document shape the file used, so writes
	// preserve it.
	codexShape bool
	loaded     bool
	loadErr    error
}

func newAuthenticator(client *http.Client) *authenticator {
	return &authenticator{client: client, tokenURL: oauthTokenURL}
}

// defaultAuthPath is where `codex login` writes auth.json.
func defaultAuthPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "/root"
	}
	return filepath.Join(home, ".codex", "auth.json")
}

// load resolves the credential source once: inline JSON from
// CHATGPT_AUTH_JSON / CODEX_AUTH_JSON, else the file named by
// CHATGPT_AUTH_FILE, else ~/.codex/auth.json.
func (a *authenticator) load() error {
	if a.loaded {
		return a.loadErr
	}
	a.loaded = true

	inline := os.Getenv("CHATGPT_AUTH_JSON")
	if inline == "" {
		inline = os.Getenv("CODEX_AUTH_JSON")
	}
	var raw []byte
	if inline != "" {
		raw = []byte(inline)
	} else {
		path := os.Getenv("CHATGPT_AUTH_FILE")
		if path == "" {
			path = defaultAuthPath()
		}
		b, err := os.ReadFile(path)
		if err != nil {
			a.loadErr = authError(fmt.Sprintf(
				"no ChatGPT credentials: set CHATGPT_AUTH_JSON/CODEX_AUTH_JSON or provide %s (from `codex login`)", path))
			return a.loadErr
		}
		raw = b
		a.path = path
	}

	var f authFile
	if err := json.Unmarshal(raw, &f); err != nil {
		a.loadErr = authError("malformed ChatGPT auth.json: " + err.Error())
		return a.loadErr
	}
	a.codexShape = f.Tokens != nil
	a.tok = f.creds()
	if a.tok.AccessToken == "" && a.tok.RefreshToken == "" {
		a.loadErr = authError("ChatGPT auth.json has neither access_token nor refresh_token")
		return a.loadErr
	}
	if a.tok.AccountID == "" {
		a.tok.AccountID = accountIDFromToken(a.tok.IDToken)
		if a.tok.AccountID == "" {
			a.tok.AccountID = accountIDFromToken(a.tok.AccessToken)
		}
	}
	return nil
}

// accessToken returns a currently valid access token plus the account id,
// refreshing through the OAuth endpoint when the stored token is expired.
func (a *authenticator) accessToken(ctx context.Context) (token, accountID string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.load(); err != nil {
		return "", "", err
	}
	if a.tok.AccessToken != "" && !expired(a.tok.AccessToken) {
		return a.tok.AccessToken, a.tok.AccountID, nil
	}
	if a.tok.RefreshToken == "" {
		return "", "", authError("ChatGPT access token expired and no refresh_token present — re-run `codex login`")
	}
	if err := a.refresh(ctx); err != nil {
		return "", "", err
	}
	return a.tok.AccessToken, a.tok.AccountID, nil
}

// refresh exchanges the refresh token for a fresh access token and persists
// the rotated credential set when file-backed. Caller holds a.mu.
func (a *authenticator) refresh(ctx context.Context) error {
	body, _ := json.Marshal(map[string]string{
		"client_id":     oauthClientID,
		"grant_type":    "refresh_token",
		"refresh_token": a.tok.RefreshToken,
		"scope":         "openid profile email",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.tokenURL, bytes.NewReader(body))
	if err != nil {
		return authError("build refresh request: " + err.Error())
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		return authError("refresh ChatGPT token: " + err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return authError(fmt.Sprintf("refresh ChatGPT token: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))))
	}

	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return authError("refresh ChatGPT token: malformed response")
	}
	a.tok.AccessToken = out.AccessToken
	if out.RefreshToken != "" {
		a.tok.RefreshToken = out.RefreshToken
	}
	if out.IDToken != "" {
		a.tok.IDToken = out.IDToken
	}
	if id := accountIDFromToken(a.tok.IDToken); id != "" {
		a.tok.AccountID = id
	}
	a.persist()
	return nil
}

// persist writes the current credential set back to the source file (in the
// shape it was read in), best effort — an inline-JSON source has no file.
func (a *authenticator) persist() {
	if a.path == "" {
		return
	}
	var doc any
	if a.codexShape {
		doc = authFile{Tokens: &a.tok}
	} else {
		doc = authFile{
			AccessToken:  a.tok.AccessToken,
			RefreshToken: a.tok.RefreshToken,
			IDToken:      a.tok.IDToken,
			AccountID:    a.tok.AccountID,
		}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return
	}
	_ = os.WriteFile(a.path, raw, 0o600)
}

// expired reports whether a JWT's exp claim is in the past (with skew). A
// token whose claims can't be read is treated as expired so we refresh
// rather than send a dud.
func expired(token string) bool {
	claims := jwtClaims(token)
	exp, ok := claims["exp"].(float64)
	if !ok {
		return true
	}
	return time.Now().After(time.Unix(int64(exp), 0).Add(-tokenExpirySkew))
}

// accountIDFromToken extracts the ChatGPT account id claim OpenAI embeds in
// its OAuth JWTs.
func accountIDFromToken(token string) string {
	claims := jwtClaims(token)
	auth, ok := claims["https://api.openai.com/auth"].(map[string]any)
	if !ok {
		return ""
	}
	id, _ := auth["chatgpt_account_id"].(string)
	return id
}

// jwtClaims decodes a JWT's payload segment without verifying it (we only
// read expiry and account id; the backend does the verification that
// matters).
func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		return nil
	}
	return claims
}

// authError builds the provider's standard authentication error.
func authError(msg string) *api.Error {
	return &api.Error{
		Type:       api.ErrAuthentication,
		StatusCode: 401,
		Provider:   "chatgpt",
		Message:    msg,
	}
}
