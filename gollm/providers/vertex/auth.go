package vertex

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/based64god/gollm/api"
)

const (
	cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform"
	defaultTokenURL    = "https://oauth2.googleapis.com/token"
	jwtBearerGrant     = "urn:ietf:params:oauth:grant-type:jwt-bearer"
	// tokenSkew refreshes cached tokens this long before they expire.
	tokenSkew = 60 * time.Second
)

// serviceAccount is the subset of a Google service-account key file the JWT
// bearer grant needs.
type serviceAccount struct {
	Type         string `json:"type"`
	ProjectID    string `json:"project_id"`
	PrivateKeyID string `json:"private_key_id"`
	PrivateKey   string `json:"private_key"`
	ClientEmail  string `json:"client_email"`
	TokenURI     string `json:"token_uri"`
}

func parseServiceAccount(data []byte) (*serviceAccount, error) {
	var sa serviceAccount
	if err := json.Unmarshal(data, &sa); err != nil {
		return nil, fmt.Errorf("invalid service-account JSON: %v", err)
	}
	if sa.ClientEmail == "" || sa.PrivateKey == "" {
		return nil, fmt.Errorf("service-account JSON missing client_email or private_key")
	}
	return &sa, nil
}

// tokenSource mints OAuth2 access tokens for one service account via the JWT
// bearer grant and caches them until shortly before expiry.
type tokenSource struct {
	client   *http.Client
	sa       *serviceAccount
	tokenURL string

	mu      sync.Mutex
	tok     string
	exp     time.Time
	refresh *refreshCall // in-flight mint; nil when idle
}

// refreshCall is one in-flight token mint shared by concurrent callers: the
// leader performs the HTTP round trip, followers wait on done (or their own
// ctx) instead of minting again or blocking on the mutex.
type refreshCall struct {
	done chan struct{} // closed after tok/err are set
	tok  string
	err  error
}

// token returns the cached access token, minting a fresh one when it is
// missing or within tokenSkew of expiry. The mutex only guards state — the
// mint HTTP round trip runs unlocked — so a hung mint never wedges callers
// whose ctx is cancelled, and one refresh serves all concurrent callers.
func (t *tokenSource) token(ctx context.Context) (string, error) {
	t.mu.Lock()
	if t.tok != "" && time.Now().Before(t.exp.Add(-tokenSkew)) {
		tok := t.tok
		t.mu.Unlock()
		return tok, nil
	}
	if call := t.refresh; call != nil {
		t.mu.Unlock()
		select {
		case <-call.done:
			return call.tok, call.err
		case <-ctx.Done():
			return "", api.WrapTransport(providerName, "", ctx.Err())
		}
	}
	call := &refreshCall{done: make(chan struct{})}
	t.refresh = call
	t.mu.Unlock()

	tok, exp, err := t.mint(ctx)

	t.mu.Lock()
	if err == nil {
		t.tok, t.exp = tok, exp
	}
	t.refresh = nil
	t.mu.Unlock()

	call.tok, call.err = tok, err
	close(call.done)
	return tok, err
}

// mint performs one JWT-bearer grant against the token endpoint.
func (t *tokenSource) mint(ctx context.Context) (string, time.Time, error) {
	assertion, err := signJWT(t.sa, t.tokenURL, time.Now())
	if err != nil {
		return "", time.Time{}, authError(fmt.Sprintf("cannot sign service-account JWT: %v", err))
	}
	form := url.Values{
		"grant_type": {jwtBearerGrant},
		"assertion":  {assertion},
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, t.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, api.WrapTransport(providerName, "", err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := t.client.Do(httpReq)
	if err != nil {
		return "", time.Time{}, api.WrapTransport(providerName, "", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return "", time.Time{}, authError(fmt.Sprintf("token endpoint returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body))))
	}

	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", time.Time{}, authError("token endpoint returned no access_token")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 3600
	}
	return out.AccessToken, time.Now().Add(time.Duration(out.ExpiresIn) * time.Second), nil
}

// signJWT builds and RS256-signs the bearer assertion: iss=client_email,
// scope=cloud-platform, aud=the token URL, exp=+1h.
func signJWT(sa *serviceAccount, aud string, now time.Time) (string, error) {
	key, err := parseRSAKey(sa.PrivateKey)
	if err != nil {
		return "", err
	}

	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	if sa.PrivateKeyID != "" {
		header["kid"] = sa.PrivateKeyID
	}
	claims := map[string]any{
		"iss":   sa.ClientEmail,
		"scope": cloudPlatformScope,
		"aud":   aud,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)

	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// parseRSAKey decodes the PEM private key: PKCS8 (what Google issues), with a
// PKCS1 fallback for older key files.
func parseRSAKey(pemStr string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("private_key is not PEM")
	}
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("private_key is not an RSA key")
		}
		return rsaKey, nil
	}
	return x509.ParsePKCS1PrivateKey(block.Bytes)
}

func authError(msg string) *api.Error {
	return &api.Error{Type: api.ErrAuthentication, StatusCode: 401, Provider: providerName, Message: msg}
}
