package proxy

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/based64god/gollm"
	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/router"
)

// Server is the gollm proxy: Anthropic-format /v1/messages (the endpoint
// Claude Code talks to), OpenAI-format /v1/chat/completions and friends, and
// key/spend administration.
type Server struct {
	cfg       *Config
	router    *router.Router
	client    *gollm.Client
	masterKey string
	keys      *keyStore
	spend     *spendLog
	log       *slog.Logger

	// aliasEntries indexes the config's model list by alias, for the
	// passthrough decision (which is proxy-level, not router-level).
	aliasEntries map[string][]ModelEntry

	mux *http.ServeMux
}

// New builds a Server from config. logger nil = slog.Default().
func New(cfg *Config, logger *slog.Logger) (*Server, error) {
	if logger == nil {
		logger = slog.Default()
	}
	client := gollm.New()
	rt, err := router.New(client, cfg.RouterConfig())
	if err != nil {
		return nil, fmt.Errorf("router: %w", err)
	}
	keys, err := newKeyStore(cfg.GeneralSettings.KeysFile)
	if err != nil {
		return nil, err
	}

	s := &Server{
		cfg:          cfg,
		router:       rt,
		client:       client,
		masterKey:    cfg.GeneralSettings.MasterKey,
		keys:         keys,
		spend:        newSpendLog(),
		log:          logger,
		aliasEntries: map[string][]ModelEntry{},
	}
	for _, e := range cfg.ModelList {
		s.aliasEntries[e.ModelName] = append(s.aliasEntries[e.ModelName], e)
	}
	if s.masterKey == "" {
		logger.Warn("no master_key configured — the proxy is unauthenticated")
	}
	s.warnMixedPassthrough()

	mux := http.NewServeMux()
	// Anthropic surface (Claude Code).
	mux.HandleFunc("POST /v1/messages", s.handleMessages)
	mux.HandleFunc("POST /v1/messages/count_tokens", s.handleCountTokens)
	// OpenAI surface. Both /v1/ and bare paths, like litellm.
	mux.HandleFunc("POST /v1/chat/completions", s.handleChatCompletions)
	mux.HandleFunc("POST /chat/completions", s.handleChatCompletions)
	mux.HandleFunc("POST /v1/embeddings", s.handleEmbeddings)
	mux.HandleFunc("POST /embeddings", s.handleEmbeddings)
	mux.HandleFunc("GET /v1/models", s.handleModels)
	mux.HandleFunc("GET /models", s.handleModels)
	// Admin.
	mux.HandleFunc("POST /key/generate", s.handleKeyGenerate)
	mux.HandleFunc("GET /key/info", s.handleKeyInfo)
	mux.HandleFunc("GET /spend/logs", s.handleSpendLogs)
	// Health.
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /health/liveliness", s.handleHealth)
	mux.HandleFunc("GET /health/readiness", s.handleHealth)
	s.mux = mux
	return s, nil
}

// Router exposes the underlying router (for tests and embedding).
func (s *Server) Router() *router.Router { return s.router }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Panic guard: a handler bug must yield a 500, not kill the listener.
	defer func() {
		if rec := recover(); rec != nil {
			s.log.Error("panic in handler", "path", r.URL.Path, "panic", rec)
			// Headers may already be gone; best effort.
			http.Error(w, `{"error":{"type":"api_error","message":"internal panic"}}`, http.StatusInternalServerError)
		}
	}()
	s.mux.ServeHTTP(w, r)
}

// ── shared helpers ──────────────────────────────────────────────────────────

// maxBodyBytes bounds request bodies (Claude Code sends multi-MB histories;
// 100MB is far above any legitimate request).
const maxBodyBytes = 100 << 20

// keyAlias names a virtual key for spend entries ("" for master/no auth).
func keyAlias(vk *VirtualKey) string {
	if vk == nil {
		return ""
	}
	if vk.Alias != "" {
		return vk.Alias
	}
	// Avoid logging the raw key; last 6 chars identify it well enough.
	if n := len(vk.Key); n > 6 {
		return "…" + vk.Key[n-6:]
	}
	return vk.Key
}

// record logs and accounts one finished request.
func (s *Server) record(e SpendEntry, vk *VirtualKey) {
	s.spend.add(e)
	if vk != nil {
		s.keys.addSpend(vk.Key, e.Cost)
	}
	s.log.Info("request",
		"endpoint", e.Endpoint,
		"model", e.ModelAlias,
		"status", e.Status,
		"stream", e.Stream,
		"prompt_tokens", e.PromptTokens,
		"completion_tokens", e.CompletionTokens,
		"cost_usd", e.Cost,
		"duration_ms", e.Duration.Milliseconds(),
		"key", e.KeyAlias,
		"error", e.Error,
	)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ── admin + health handlers ─────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	// Liveness/readiness disclose nothing: an unauthenticated probe must not
	// leak the configured model list or cumulative spend. The model list and
	// spend are available to the master key via /v1/models and /spend/logs.
	writeJSON(w, http.StatusOK, map[string]any{"status": "healthy"})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if _, aerr := s.authenticate(r, ""); aerr != nil {
		writeOpenAIError(w, aerr.status, aerr.message)
		return
	}
	type model struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		OwnedBy string `json:"owned_by"`
	}
	out := struct {
		Object string  `json:"object"`
		Data   []model `json:"data"`
	}{Object: "list"}
	for _, name := range s.router.ModelNames() {
		out.Data = append(out.Data, model{ID: name, Object: "model", Created: 0, OwnedBy: "gollm"})
	}
	writeJSON(w, http.StatusOK, out)
}

// requireMaster gates admin endpoints on the master key specifically.
func (s *Server) requireMaster(r *http.Request) *authError {
	if s.masterKey == "" {
		return nil
	}
	if bearerOrAPIKey(r) != s.masterKey {
		return &authError{http.StatusForbidden, "admin endpoints require the master key"}
	}
	return nil
}

func (s *Server) handleKeyGenerate(w http.ResponseWriter, r *http.Request) {
	if aerr := s.requireMaster(r); aerr != nil {
		writeOpenAIError(w, aerr.status, aerr.message)
		return
	}
	var req struct {
		KeyAlias  string   `json:"key_alias"`
		MaxBudget float64  `json:"max_budget"`
		Models    []string `json:"models"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "malformed JSON body: "+err.Error())
		return
	}
	vk := s.keys.generate(req.KeyAlias, req.MaxBudget, req.Models)
	writeJSON(w, http.StatusOK, vk)
}

func (s *Server) handleKeyInfo(w http.ResponseWriter, r *http.Request) {
	if aerr := s.requireMaster(r); aerr != nil {
		writeOpenAIError(w, aerr.status, aerr.message)
		return
	}
	key := r.URL.Query().Get("key")
	vk, ok := s.keys.lookup(key)
	if !ok {
		writeOpenAIError(w, http.StatusNotFound, "unknown key")
		return
	}
	writeJSON(w, http.StatusOK, vk)
}

func (s *Server) handleSpendLogs(w http.ResponseWriter, r *http.Request) {
	if aerr := s.requireMaster(r); aerr != nil {
		writeOpenAIError(w, aerr.status, aerr.message)
		return
	}
	n := 100
	if q := r.URL.Query().Get("limit"); q != "" {
		if v, err := strconv.Atoi(q); err == nil && v > 0 {
			n = v
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total_spend": s.spend.totalSpend(),
		"logs":        s.spend.recent(n),
	})
}

// ── passthrough decision ────────────────────────────────────────────────────

// entriesForAlias returns the config entries serving a request alias: an exact
// model_name match, or — failing that — wildcard model_names ("claude-*") whose
// prefix the alias shares. Mirrors the router's alias resolution so the
// passthrough decision sees the same deployments the router would route to.
func (s *Server) entriesForAlias(alias string) []ModelEntry {
	if exact := s.aliasEntries[alias]; len(exact) > 0 {
		return exact
	}
	var out []ModelEntry
	for name, entries := range s.aliasEntries {
		if prefix, ok := strings.CutSuffix(name, "*"); ok && strings.HasPrefix(alias, prefix) {
			out = append(out, entries...)
		}
	}
	return out
}

// passthroughEligible reports whether Anthropic-format traffic for an alias
// may be forwarded verbatim (preserving cache_control and thinking signatures)
// rather than translated: every deployment behind it must be an
// anthropic-provider model and none may opt out. A mixed pool (any
// non-anthropic deployment) is not eligible — verbatim bytes can't be sent to,
// say, an OpenAI backend — so it falls back to translation.
func (s *Server) passthroughEligible(alias string) bool {
	entries := s.entriesForAlias(alias)
	if len(entries) == 0 {
		return false
	}
	for _, e := range entries {
		provider, _ := api.SplitModel(e.Params.Model)
		if provider != "anthropic" {
			return false
		}
		if e.Params.Passthrough != nil && !*e.Params.Passthrough {
			return false
		}
	}
	return true
}

// warnMixedPassthrough logs when an alias sets passthrough:true on some
// deployment but is not passthrough-eligible (a non-anthropic deployment shares
// the alias), so the operator learns cache_control won't be preserved rather
// than discovering it silently. Called once at startup.
func (s *Server) warnMixedPassthrough() {
	for alias, entries := range s.aliasEntries {
		wantsPassthrough := false
		for _, e := range entries {
			if e.Params.Passthrough != nil && *e.Params.Passthrough {
				wantsPassthrough = true
			}
		}
		if wantsPassthrough && !s.passthroughEligible(alias) {
			s.log.Warn("passthrough requested but disabled: alias mixes an anthropic backend with a non-anthropic one; requests will be translated and cache_control will not be preserved",
				"model", alias)
		}
	}
}

// providerLocalModel strips the provider prefix from a config model string.
func providerLocalModel(model string) string {
	_, rest := api.SplitModel(model)
	return rest
}
