package proxy

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// covACServer builds a proxy with master-key auth and a single alias, without
// needing a live upstream (authenticate/keystore paths never dial the backend).
func covACServer(t *testing.T, masterKey string) *Server {
	t.Helper()
	yaml := `
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: fake-openai-key
      api_base: http://example.invalid
`
	if masterKey != "" {
		yaml += "general_settings:\n  master_key: " + masterKey + "\n"
	}
	cfg, err := ParseConfig([]byte(yaml))
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	srv, err := New(cfg, testLogger())
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	return srv
}

// ── auth.go: containsModel ──────────────────────────────────────────────────

func TestCovACContainsModel(t *testing.T) {
	tests := []struct {
		name    string
		allowed []string
		alias   string
		want    bool
	}{
		{"exact match", []string{"claude-sonnet-4-5"}, "claude-sonnet-4-5", true},
		{"exact among several", []string{"a", "claude-sonnet-4-5", "b"}, "claude-sonnet-4-5", true},
		{"wildcard prefix match", []string{"claude-*"}, "claude-opus-4-6", true},
		{"wildcard empty suffix matches all", []string{"*"}, "anything-goes", true},
		{"wildcard prefix no match", []string{"claude-*"}, "gpt-4o", false},
		{"no match", []string{"a", "b"}, "c", false},
		{"nil list", nil, "anything", false},
		{"empty list", []string{}, "x", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := containsModel(tc.allowed, tc.alias); got != tc.want {
				t.Errorf("containsModel(%v, %q) = %v, want %v", tc.allowed, tc.alias, got, tc.want)
			}
		})
	}
}

// ── auth.go: authError.Error ────────────────────────────────────────────────

func TestCovACAuthErrorMessage(t *testing.T) {
	e := &authError{status: http.StatusForbidden, message: "not permitted"}
	if e.Error() != "not permitted" {
		t.Errorf("Error() = %q, want the message field", e.Error())
	}
	// It must satisfy the error interface.
	var err error = e
	if err.Error() != "not permitted" {
		t.Errorf("as error: Error() = %q", err.Error())
	}
}

// ── auth.go: newKeyStore ────────────────────────────────────────────────────

func TestCovACNewKeyStoreMemoryOnly(t *testing.T) {
	s, err := newKeyStore("")
	if err != nil {
		t.Fatalf("newKeyStore(\"\") error = %v", err)
	}
	if s.path != "" {
		t.Errorf("path = %q, want empty", s.path)
	}
	if _, ok := s.lookup("anything"); ok {
		t.Errorf("memory store should start empty")
	}
	// persist on a memory-only store is a silent no-op (no path to write to).
	s.generate("x", 0, nil) // exercises persist() with path=="".
}

func TestCovACNewKeyStoreNonexistentPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "does-not-exist.json")
	s, err := newKeyStore(path)
	if err != nil {
		t.Fatalf("newKeyStore(nonexistent) error = %v, want nil", err)
	}
	if s == nil {
		t.Fatal("store is nil")
	}
	if _, ok := s.lookup("anything"); ok {
		t.Errorf("store from a nonexistent path should be empty")
	}
}

func TestCovACNewKeyStoreValidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	blob := `[{"key":"sk-gollm-abc","key_alias":"loaded","max_budget":10,"spend":2.5,"models":["m1","m2"]}]`
	if err := os.WriteFile(path, []byte(blob), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := newKeyStore(path)
	if err != nil {
		t.Fatalf("newKeyStore(valid) error = %v", err)
	}
	got, ok := s.lookup("sk-gollm-abc")
	if !ok {
		t.Fatal("key from file not loaded")
	}
	if got.Alias != "loaded" || got.MaxBudget != 10 || got.Spend != 2.5 {
		t.Errorf("loaded key = %+v", got)
	}
	if len(got.Models) != 2 || got.Models[0] != "m1" || got.Models[1] != "m2" {
		t.Errorf("loaded models = %v", got.Models)
	}
}

func TestCovACNewKeyStoreInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte(`{not json at all`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newKeyStore(path); err == nil {
		t.Fatal("newKeyStore(invalid JSON) error = nil, want error")
	}
}

// ── auth.go: persist + generate + addSpend round-trip ───────────────────────

func TestCovACPersistAddSpendRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	s, err := newKeyStore(path)
	if err != nil {
		t.Fatalf("newKeyStore: %v", err)
	}

	k := s.generate("tester", 5.0, []string{"claude-sonnet-4-5"})
	if k.Spend != 0 {
		t.Fatalf("fresh key spend = %v, want 0", k.Spend)
	}

	// cost == 0 is a no-op: spend stays 0.
	s.addSpend(k.Key, 0)
	if cur, _ := s.lookup(k.Key); cur.Spend != 0 {
		t.Errorf("after addSpend 0, spend = %v, want 0", cur.Spend)
	}

	// A real charge accumulates.
	s.addSpend(k.Key, 1.5)
	s.addSpend(k.Key, 0.25)
	if cur, _ := s.lookup(k.Key); cur.Spend != 1.75 {
		t.Errorf("accumulated spend = %v, want 1.75", cur.Spend)
	}

	// addSpend on an unknown key is a no-op — it must not create a phantom key
	// nor disturb the real one.
	s.addSpend("sk-gollm-unknown", 99)
	if _, ok := s.lookup("sk-gollm-unknown"); ok {
		t.Error("addSpend on unknown key created a key")
	}
	if cur, _ := s.lookup(k.Key); cur.Spend != 1.75 {
		t.Errorf("real key spend disturbed = %v", cur.Spend)
	}

	// Reload from disk: generate + addSpend must have persisted the key and its
	// accumulated spend.
	reloaded, err := newKeyStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	got, ok := reloaded.lookup(k.Key)
	if !ok {
		t.Fatal("generated key was not persisted")
	}
	if got.Alias != "tester" || got.MaxBudget != 5.0 || got.Spend != 1.75 {
		t.Errorf("persisted key = %+v", got)
	}
	if _, ok := reloaded.lookup("sk-gollm-unknown"); ok {
		t.Error("phantom key persisted to disk")
	}
}

// ── auth.go: (*Server).authenticate ─────────────────────────────────────────

func TestCovACAuthenticateNoMasterKey(t *testing.T) {
	srv := covACServer(t, "") // development mode: auth disabled.
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	vk, aerr := srv.authenticate(req, "claude-sonnet-4-5")
	if vk != nil || aerr != nil {
		t.Errorf("authenticate with no master key = (%v, %v), want (nil, nil)", vk, aerr)
	}
}

func TestCovACAuthenticateMissingCredential(t *testing.T) {
	srv := covACServer(t, "sk-master-test")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	vk, aerr := srv.authenticate(req, "claude-sonnet-4-5")
	if vk != nil {
		t.Errorf("vk = %v, want nil", vk)
	}
	if aerr == nil || aerr.status != http.StatusUnauthorized {
		t.Fatalf("aerr = %v, want 401", aerr)
	}
}

func TestCovACAuthenticateMasterKey(t *testing.T) {
	srv := covACServer(t, "sk-master-test")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("x-api-key", "sk-master-test")
	vk, aerr := srv.authenticate(req, "claude-sonnet-4-5")
	if vk != nil || aerr != nil {
		t.Errorf("master key auth = (%v, %v), want (nil, nil)", vk, aerr)
	}
}

func TestCovACAuthenticateUnknownKey(t *testing.T) {
	srv := covACServer(t, "sk-master-test")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("Authorization", "Bearer sk-gollm-nope")
	vk, aerr := srv.authenticate(req, "claude-sonnet-4-5")
	if vk != nil {
		t.Errorf("vk = %v, want nil", vk)
	}
	if aerr == nil || aerr.status != http.StatusUnauthorized || aerr.message != "invalid API key" {
		t.Fatalf("aerr = %v, want 401 invalid API key", aerr)
	}
}

func TestCovACAuthenticateOverBudget(t *testing.T) {
	srv := covACServer(t, "sk-master-test")
	k := srv.keys.generate("poor", 1.0, nil)
	srv.keys.addSpend(k.Key, 1.0) // spend now equals the budget.

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("x-api-key", k.Key)
	vk, aerr := srv.authenticate(req, "claude-sonnet-4-5")
	if vk != nil {
		t.Errorf("vk = %v, want nil on refusal", vk)
	}
	if aerr == nil || aerr.status != http.StatusTooManyRequests {
		t.Fatalf("aerr = %v, want 429", aerr)
	}
}

func TestCovACAuthenticateModelNotAllowed(t *testing.T) {
	srv := covACServer(t, "sk-master-test")
	k := srv.keys.generate("scoped", 0, []string{"claude-sonnet-4-5"})

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("x-api-key", k.Key)
	vk, aerr := srv.authenticate(req, "some-other-model")
	if vk != nil {
		t.Errorf("vk = %v, want nil on refusal", vk)
	}
	if aerr == nil || aerr.status != http.StatusForbidden {
		t.Fatalf("aerr = %v, want 403", aerr)
	}
}

func TestCovACAuthenticateValidKey(t *testing.T) {
	srv := covACServer(t, "sk-master-test")
	k := srv.keys.generate("ok", 100.0, []string{"claude-sonnet-4-5"})

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("x-api-key", k.Key)

	// Model in the allowlist → passes, returns the virtual key.
	vk, aerr := srv.authenticate(req, "claude-sonnet-4-5")
	if aerr != nil {
		t.Fatalf("aerr = %v, want nil", aerr)
	}
	if vk == nil || vk.Key != k.Key || vk.Alias != "ok" {
		t.Fatalf("vk = %+v, want the generated key", vk)
	}

	// Empty modelAlias skips the allowlist check → still returns the key.
	vk2, aerr2 := srv.authenticate(req, "")
	if aerr2 != nil || vk2 == nil || vk2.Key != k.Key {
		t.Errorf("empty-alias auth = (%+v, %v)", vk2, aerr2)
	}
}

// ── spend.go: spendLog ──────────────────────────────────────────────────────

func TestCovACSpendLogRecentAndTotal(t *testing.T) {
	l := newSpendLog()
	l.add(SpendEntry{ModelAlias: "e0", Cost: 1.5})
	l.add(SpendEntry{ModelAlias: "e1", Cost: 2.0})
	l.add(SpendEntry{ModelAlias: "e2", Cost: 0.25})

	// recent(n) is newest-first.
	got := l.recent(2)
	if len(got) != 2 {
		t.Fatalf("recent(2) len = %d, want 2", len(got))
	}
	if got[0].ModelAlias != "e2" || got[1].ModelAlias != "e1" {
		t.Errorf("recent(2) order = [%s %s], want [e2 e1]", got[0].ModelAlias, got[1].ModelAlias)
	}

	// recent(n) caps at the number added.
	all := l.recent(10)
	if len(all) != 3 {
		t.Fatalf("recent(10) len = %d, want 3 (capped)", len(all))
	}
	if all[0].ModelAlias != "e2" || all[2].ModelAlias != "e0" {
		t.Errorf("recent(10) = [%s .. %s], want newest-first e2..e0", all[0].ModelAlias, all[2].ModelAlias)
	}

	if got := l.totalSpend(); got != 3.75 {
		t.Errorf("totalSpend = %v, want 3.75", got)
	}
}

func TestCovACSpendLogRingWrap(t *testing.T) {
	l := newSpendLog()
	const n = spendLogSize + 5 // force a wrap of the fixed-size ring.
	for i := 0; i < n; i++ {
		l.add(SpendEntry{ModelAlias: strconv.Itoa(i), Cost: 1})
	}
	if !l.full {
		t.Fatal("ring should be marked full after wrapping")
	}

	// totalSpend accumulates across the wrap, uncapped by ring size.
	if got := l.totalSpend(); got != float64(n) {
		t.Errorf("totalSpend = %v, want %d", got, n)
	}

	// The freshest few come back newest-first.
	top := l.recent(3)
	if len(top) != 3 {
		t.Fatalf("recent(3) len = %d", len(top))
	}
	if top[0].ModelAlias != strconv.Itoa(n-1) || top[1].ModelAlias != strconv.Itoa(n-2) || top[2].ModelAlias != strconv.Itoa(n-3) {
		t.Errorf("recent(3) = [%s %s %s], want newest-first", top[0].ModelAlias, top[1].ModelAlias, top[2].ModelAlias)
	}

	// recent caps at ring size, returns each surviving entry exactly once.
	full := l.recent(spendLogSize + 100)
	if len(full) != spendLogSize {
		t.Fatalf("recent(oversized) len = %d, want %d", len(full), spendLogSize)
	}
	if full[0].ModelAlias != strconv.Itoa(n-1) {
		t.Errorf("newest = %s, want %d", full[0].ModelAlias, n-1)
	}
	// Oldest survivor is entry index 5 (0..4 were overwritten by the wrap).
	if full[spendLogSize-1].ModelAlias != strconv.Itoa(n-spendLogSize) {
		t.Errorf("oldest survivor = %s, want %d", full[spendLogSize-1].ModelAlias, n-spendLogSize)
	}
	seen := make(map[string]bool, len(full))
	for _, e := range full {
		if seen[e.ModelAlias] {
			t.Fatalf("duplicate entry %s in recent()", e.ModelAlias)
		}
		seen[e.ModelAlias] = true
	}
}

// ── config.go: LoadConfig ───────────────────────────────────────────────────

func TestCovACLoadConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg.yaml")
	yaml := `
model_list:
  - model_name: claude-sonnet-4-5
    params:
      model: openai/gpt-4o
      api_key: k
`
	if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig error = %v", err)
	}
	if len(cfg.ModelList) != 1 || cfg.ModelList[0].ModelName != "claude-sonnet-4-5" {
		t.Errorf("cfg.ModelList = %+v", cfg.ModelList)
	}
}

func TestCovACLoadConfigMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nope.yaml")
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("LoadConfig(nonexistent) error = nil, want error")
	}
}

// ── config.go: ParseConfig error and merge branches ─────────────────────────

func TestCovACParseConfigErrors(t *testing.T) {
	tests := []struct {
		name string
		yaml string
	}{
		{"empty model_list", "router_settings:\n  num_retries: 1\n"},
		{"missing model_name", "model_list:\n  - params:\n      model: openai/gpt-4o\n"},
		{"missing params.model", "model_list:\n  - model_name: alias-only\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseConfig([]byte(tc.yaml)); err == nil {
				t.Errorf("ParseConfig(%q) error = nil, want error", tc.name)
			}
		})
	}
}

func TestCovACParseConfigLitellmParamsMerge(t *testing.T) {
	// A deployment declared entirely under litellm_params must merge into Params.
	yaml := `
model_list:
  - model_name: claude-sonnet-4-5
    litellm_params:
      model: openai/gpt-4o
      api_key: from-litellm
      api_base: http://backend.example
`
	cfg, err := ParseConfig([]byte(yaml))
	if err != nil {
		t.Fatalf("ParseConfig error = %v", err)
	}
	p := cfg.ModelList[0].Params
	if p.Model != "openai/gpt-4o" || p.APIKey != "from-litellm" || p.APIBase != "http://backend.example" {
		t.Errorf("merged params = %+v", p)
	}
}

// ── config.go: mergeParams ──────────────────────────────────────────────────

func TestCovACMergeParams(t *testing.T) {
	on := true

	t.Run("empty dst takes src", func(t *testing.T) {
		dst := ModelParams{}
		src := ModelParams{
			Model:       "openai/gpt-4o",
			APIKey:      "sk-src",
			APIBase:     "http://src",
			Headers:     map[string]string{"X": "1"},
			Weight:      3,
			RPM:         30,
			TPM:         300,
			Passthrough: &on,
		}
		mergeParams(&dst, &src)
		if dst.Model != "openai/gpt-4o" || dst.APIKey != "sk-src" || dst.APIBase != "http://src" {
			t.Errorf("strings not merged: %+v", dst)
		}
		if dst.Headers["X"] != "1" || dst.Weight != 3 || dst.RPM != 30 || dst.TPM != 300 {
			t.Errorf("scalars/headers not merged: %+v", dst)
		}
		if dst.Passthrough == nil || *dst.Passthrough != true {
			t.Errorf("passthrough not merged: %+v", dst.Passthrough)
		}
	})

	t.Run("non-empty dst wins", func(t *testing.T) {
		off := false
		dst := ModelParams{
			Model:       "keep/model",
			APIKey:      "keep-key",
			APIBase:     "http://keep",
			Headers:     map[string]string{"keep": "yes"},
			Weight:      9,
			RPM:         99,
			TPM:         999,
			Passthrough: &off,
		}
		src := ModelParams{
			Model:       "other/model",
			APIKey:      "other-key",
			APIBase:     "http://other",
			Headers:     map[string]string{"other": "no"},
			Weight:      1,
			RPM:         1,
			TPM:         1,
			Passthrough: &on,
		}
		mergeParams(&dst, &src)
		if dst.Model != "keep/model" || dst.APIKey != "keep-key" || dst.APIBase != "http://keep" {
			t.Errorf("dst strings overwritten: %+v", dst)
		}
		if dst.Headers["keep"] != "yes" || dst.Headers["other"] != "" {
			t.Errorf("dst headers overwritten: %+v", dst.Headers)
		}
		if dst.Weight != 9 || dst.RPM != 99 || dst.TPM != 999 {
			t.Errorf("dst scalars overwritten: %+v", dst)
		}
		if dst.Passthrough == nil || *dst.Passthrough != false {
			t.Errorf("dst passthrough overwritten: %+v", dst.Passthrough)
		}
	})
}

// ── config.go: flattenFallbacks ─────────────────────────────────────────────

func TestCovACFlattenFallbacks(t *testing.T) {
	if got := flattenFallbacks(nil); got != nil {
		t.Errorf("flattenFallbacks(nil) = %v, want nil", got)
	}
	if got := flattenFallbacks([]map[string][]string{}); got != nil {
		t.Errorf("flattenFallbacks(empty) = %v, want nil", got)
	}

	list := []map[string][]string{
		{"a": {"x"}},
		{"a": {"y"}},
		{"b": {"z"}},
	}
	got := flattenFallbacks(list)
	if len(got) != 2 {
		t.Fatalf("folded map = %v, want 2 keys", got)
	}
	if len(got["a"]) != 2 || got["a"][0] != "x" || got["a"][1] != "y" {
		t.Errorf("got[a] = %v, want [x y]", got["a"])
	}
	if len(got["b"]) != 1 || got["b"][0] != "z" {
		t.Errorf("got[b] = %v, want [z]", got["b"])
	}
}

// ── config.go: resolveEnv ───────────────────────────────────────────────────

func TestCovACResolveEnv(t *testing.T) {
	t.Setenv("COVAC_SECRET", "resolved-value")

	if got := resolveEnv("os.environ/COVAC_SECRET"); got != "resolved-value" {
		t.Errorf("resolveEnv(os.environ/COVAC_SECRET) = %q, want resolved-value", got)
	}
	if got := resolveEnv("plain-literal"); got != "plain-literal" {
		t.Errorf("resolveEnv(plain) = %q, want itself", got)
	}
	if got := resolveEnv("os.environ/COVAC_UNSET_VAR"); got != "" {
		t.Errorf("resolveEnv(unset var) = %q, want empty", got)
	}
}
