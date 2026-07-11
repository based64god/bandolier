package proxy

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// VirtualKey is a proxy-issued credential with optional budget and model
// restrictions — litellm's virtual keys.
type VirtualKey struct {
	Key       string    `json:"key"`
	Alias     string    `json:"key_alias,omitempty"`
	MaxBudget float64   `json:"max_budget,omitempty"` // USD; 0 = unlimited
	Spend     float64   `json:"spend"`
	Models    []string  `json:"models,omitempty"` // allowed aliases; empty = all
	CreatedAt time.Time `json:"created_at"`
}

// keyStore holds virtual keys, optionally persisted to a JSON file. All
// methods are safe for concurrent use.
type keyStore struct {
	mu   sync.Mutex
	keys map[string]*VirtualKey
	path string // "" = memory only
}

func newKeyStore(path string) (*keyStore, error) {
	s := &keyStore{keys: map[string]*VirtualKey{}, path: path}
	if path == "" {
		return s, nil
	}
	raw, err := os.ReadFile(path)
	switch {
	case os.IsNotExist(err):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("read keys file: %w", err)
	}
	var list []*VirtualKey
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("parse keys file %s: %w", path, err)
	}
	for _, k := range list {
		s.keys[k.Key] = k
	}
	return s, nil
}

// persist writes the store to disk (caller holds the lock). Best-effort by
// design: spend accounting must not fail requests over a disk hiccup.
func (s *keyStore) persist() {
	if s.path == "" {
		return
	}
	list := make([]*VirtualKey, 0, len(s.keys))
	for _, k := range s.keys {
		list = append(list, k)
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}

func (s *keyStore) generate(alias string, maxBudget float64, models []string) *VirtualKey {
	var b [24]byte
	_, _ = rand.Read(b[:])
	k := &VirtualKey{
		Key:       "sk-gollm-" + hex.EncodeToString(b[:]),
		Alias:     alias,
		MaxBudget: maxBudget,
		Models:    models,
		CreatedAt: time.Now().UTC(),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys[k.Key] = k
	s.persist()
	return k
}

func (s *keyStore) lookup(key string) (*VirtualKey, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k, ok := s.keys[key]
	if !ok {
		return nil, false
	}
	cp := *k
	return &cp, true
}

// addSpend accumulates cost against a key. Unknown keys (master key traffic)
// are a no-op.
func (s *keyStore) addSpend(key string, cost float64) {
	if cost == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if k, ok := s.keys[key]; ok {
		k.Spend += cost
		s.persist()
	}
}

// authError describes an authentication/authorization refusal.
type authError struct {
	status  int
	message string
}

func (e *authError) Error() string { return e.message }

// bearerOrAPIKey extracts the caller's credential: Authorization Bearer
// (OpenAI style, and Claude Code with ANTHROPIC_AUTH_TOKEN) or x-api-key
// (Anthropic style).
func bearerOrAPIKey(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	return strings.TrimSpace(r.Header.Get("x-api-key"))
}

// authenticate validates the request credential. With no master key
// configured, everything passes (development mode). Returns the virtual key
// when the credential is one (nil for the master key), so handlers can
// enforce budgets/model allowlists and attribute spend.
func (s *Server) authenticate(r *http.Request, modelAlias string) (*VirtualKey, *authError) {
	if s.masterKey == "" {
		return nil, nil
	}
	cred := bearerOrAPIKey(r)
	if cred == "" {
		return nil, &authError{http.StatusUnauthorized, "missing credentials: pass Authorization: Bearer <key> or x-api-key"}
	}
	if subtle.ConstantTimeCompare([]byte(cred), []byte(s.masterKey)) == 1 {
		return nil, nil
	}
	vk, ok := s.keys.lookup(cred)
	if !ok {
		return nil, &authError{http.StatusUnauthorized, "invalid API key"}
	}
	if vk.MaxBudget > 0 && vk.Spend >= vk.MaxBudget {
		return nil, &authError{http.StatusTooManyRequests, fmt.Sprintf(
			"budget exceeded: spend %.6f USD ≥ max_budget %.6f USD", vk.Spend, vk.MaxBudget)}
	}
	if modelAlias != "" && len(vk.Models) > 0 && !containsModel(vk.Models, modelAlias) {
		return nil, &authError{http.StatusForbidden, fmt.Sprintf("key not permitted for model %q", modelAlias)}
	}
	return vk, nil
}

func containsModel(allowed []string, alias string) bool {
	for _, m := range allowed {
		if m == alias {
			return true
		}
		if suffix, ok := strings.CutSuffix(m, "*"); ok && strings.HasPrefix(alias, suffix) {
			return true
		}
	}
	return false
}
