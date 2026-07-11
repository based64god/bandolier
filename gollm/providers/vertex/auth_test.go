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
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/based64god/gollm/api"
)

// testKey generates a throwaway RSA key and its PKCS8 PEM encoding.
func testKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("MarshalPKCS8PrivateKey: %v", err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

// testCredentials renders a service-account key file for the fake token flow.
func testCredentials(t *testing.T, pemKey, tokenURL string) string {
	t.Helper()
	b, err := json.Marshal(map[string]string{
		"type":           "service_account",
		"project_id":     "sa-project",
		"private_key_id": "kid-1",
		"private_key":    pemKey,
		"client_email":   "svc@test.iam.gserviceaccount.com",
		"token_uri":      tokenURL,
	})
	if err != nil {
		t.Fatalf("marshal credentials: %v", err)
	}
	return string(b)
}

func decodeJWT(t *testing.T, jwt string) (header, claims map[string]any, signingInput string, sig []byte) {
	t.Helper()
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT has %d segments, want 3", len(parts))
	}
	dec := func(s string) []byte {
		b, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			t.Fatalf("base64url decode: %v", err)
		}
		return b
	}
	if err := json.Unmarshal(dec(parts[0]), &header); err != nil {
		t.Fatalf("decode header: %v", err)
	}
	if err := json.Unmarshal(dec(parts[1]), &claims); err != nil {
		t.Fatalf("decode claims: %v", err)
	}
	return header, claims, parts[0] + "." + parts[1], dec(parts[2])
}

// fakeTokenServer serves the OAuth token endpoint, counting hits and
// capturing the last JWT assertion.
func fakeTokenServer(t *testing.T, hits *int, assertion *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
		}
		if got := r.Form.Get("grant_type"); got != jwtBearerGrant {
			t.Errorf("grant_type = %q, want %q", got, jwtBearerGrant)
		}
		*assertion = r.Form.Get("assertion")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"access_token":"fake-token","expires_in":3600,"token_type":"Bearer"}`)
	}))
}

func TestTokenMintClaimsAndCaching(t *testing.T) {
	key, pemKey := testKey(t)
	var hits int
	var assertion string
	srv := fakeTokenServer(t, &hits, &assertion)
	defer srv.Close()

	sa, err := parseServiceAccount([]byte(testCredentials(t, pemKey, srv.URL)))
	if err != nil {
		t.Fatalf("parseServiceAccount: %v", err)
	}
	ts := &tokenSource{client: srv.Client(), sa: sa, tokenURL: srv.URL}

	tok, err := ts.token(context.Background())
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if tok != "fake-token" {
		t.Errorf("token = %q, want fake-token", tok)
	}

	header, claims, signingInput, sig := decodeJWT(t, assertion)
	if header["alg"] != "RS256" || header["typ"] != "JWT" || header["kid"] != "kid-1" {
		t.Errorf("header = %v", header)
	}
	if claims["iss"] != "svc@test.iam.gserviceaccount.com" {
		t.Errorf("iss = %v", claims["iss"])
	}
	if claims["scope"] != cloudPlatformScope {
		t.Errorf("scope = %v", claims["scope"])
	}
	if claims["aud"] != srv.URL {
		t.Errorf("aud = %v, want %s", claims["aud"], srv.URL)
	}
	iat, exp := claims["iat"].(float64), claims["exp"].(float64)
	if exp-iat != 3600 {
		t.Errorf("exp-iat = %v, want 3600", exp-iat)
	}
	digest := sha256.Sum256([]byte(signingInput))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Errorf("RS256 signature does not verify: %v", err)
	}

	// Second call is served from cache.
	if _, err := ts.token(context.Background()); err != nil {
		t.Fatalf("cached token: %v", err)
	}
	if hits != 1 {
		t.Errorf("token endpoint hits = %d, want 1", hits)
	}

	// A token within the skew window is re-minted.
	ts.exp = time.Now().Add(30 * time.Second)
	if _, err := ts.token(context.Background()); err != nil {
		t.Fatalf("refresh token: %v", err)
	}
	if hits != 2 {
		t.Errorf("token endpoint hits after expiry = %d, want 2", hits)
	}
}

func TestTokenEndpointError(t *testing.T) {
	_, pemKey := testKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusForbidden)
	}))
	defer srv.Close()

	sa, err := parseServiceAccount([]byte(testCredentials(t, pemKey, srv.URL)))
	if err != nil {
		t.Fatalf("parseServiceAccount: %v", err)
	}
	ts := &tokenSource{client: srv.Client(), sa: sa, tokenURL: srv.URL}

	_, err = ts.token(context.Background())
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("error is %T, want *api.Error", err)
	}
	if apiErr.Type != api.ErrAuthentication {
		t.Errorf("type = %s, want %s", apiErr.Type, api.ErrAuthentication)
	}
	if !strings.Contains(apiErr.Message, "invalid_grant") {
		t.Errorf("message %q should carry the endpoint body", apiErr.Message)
	}
}

func TestTokenConcurrentMintSharesOneRefresh(t *testing.T) {
	_, pemKey := testKey(t)
	const delay = 250 * time.Millisecond
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		time.Sleep(delay)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"access_token":"fake-token","expires_in":3600}`)
	}))
	defer srv.Close()

	sa, err := parseServiceAccount([]byte(testCredentials(t, pemKey, srv.URL)))
	if err != nil {
		t.Fatalf("parseServiceAccount: %v", err)
	}
	ts := &tokenSource{client: srv.Client(), sa: sa, tokenURL: srv.URL}

	start := time.Now()
	var wg sync.WaitGroup
	toks := make([]string, 2)
	errs := make([]error, 2)
	for i := range toks {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			toks[i], errs[i] = ts.token(context.Background())
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)

	for i := range toks {
		if errs[i] != nil {
			t.Fatalf("token[%d]: %v", i, errs[i])
		}
		if toks[i] != "fake-token" {
			t.Errorf("token[%d] = %q, want fake-token", i, toks[i])
		}
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("token endpoint hits = %d, want 1 (concurrent callers share one mint)", got)
	}
	if elapsed >= 2*delay {
		t.Errorf("two concurrent token() calls took %v, want < %v (mint must not serialize)", elapsed, 2*delay)
	}
}

func TestTokenCancelledCallerNotBlockedByHungMint(t *testing.T) {
	_, pemKey := testKey(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered) // panics on a second request: exactly one mint expected
		<-release
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"access_token":"fake-token","expires_in":3600}`)
	}))
	defer srv.Close()

	sa, err := parseServiceAccount([]byte(testCredentials(t, pemKey, srv.URL)))
	if err != nil {
		t.Fatalf("parseServiceAccount: %v", err)
	}
	ts := &tokenSource{client: srv.Client(), sa: sa, tokenURL: srv.URL}

	leaderErr := make(chan error, 1)
	go func() {
		_, err := ts.token(context.Background())
		leaderErr <- err
	}()
	<-entered // the leader's mint is now in flight and must not hold the lock

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	_, err = ts.token(ctx)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("cancelled caller took %v, want prompt return while mint hangs", elapsed)
	}
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("cancelled caller error is %T (%v), want *api.Error", err, err)
	}
	if apiErr.StatusCode != 499 {
		t.Errorf("cancelled caller status = %d, want 499", apiErr.StatusCode)
	}

	close(release)
	if err := <-leaderErr; err != nil {
		t.Fatalf("leader token: %v", err)
	}
	tok, err := ts.token(context.Background())
	if err != nil || tok != "fake-token" {
		t.Errorf("post-mint cached token = %q, %v", tok, err)
	}
}

func TestParseServiceAccountRejectsIncompleteKey(t *testing.T) {
	if _, err := parseServiceAccount([]byte(`{"type":"service_account"}`)); err == nil {
		t.Error("expected error for key file without client_email/private_key")
	}
	if _, err := parseServiceAccount([]byte(`not json`)); err == nil {
		t.Error("expected error for non-JSON credentials")
	}
}
