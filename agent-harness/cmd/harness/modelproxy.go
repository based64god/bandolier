package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/based64god/gollm/proxy"
)

// ── Embedded model proxy (gollm) ──────────────────────────────────────────────
//
// Every run is driven by the claude CLI. For non-Anthropic providers the
// harness starts an in-process gollm proxy — an Anthropic-format /v1/messages
// endpoint that translates to the run's real backend (OpenAI, the ChatGPT
// subscription backend, Gemini, or Vertex) — and points the CLI at it via
// ANTHROPIC_BASE_URL. The env is set process-wide so both this process's
// claude invocations (one-shot driver, writer model) and the acp-agent child
// process inherit the rewrite; the proxy itself lives only in the main
// harness process and serves on 127.0.0.1.

// needsModelProxy reports whether the provider's traffic must be rewritten
// through the embedded proxy. Anthropic and Bedrock speak the claude CLI's
// native protocols already.
func needsModelProxy(p providerKind) bool {
	return p == providerOpenAI || p == providerGemini
}

// startModelProxy builds the run's gollm config, starts the proxy on an
// ephemeral localhost port, and exports ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN (and ANTHROPIC_SMALL_FAST_MODEL when a writer model is
// configured) for every subsequent claude invocation. The returned stop
// function shuts the listener down; the proxy carries no state worth
// draining, so stop is best effort.
func startModelProxy(cfg config) (stop func(), err error) {
	backend, err := backendPrefix(cfg)
	if err != nil {
		return nil, err
	}

	masterKey, err := randomKey()
	if err != nil {
		return nil, err
	}

	pcfg := &proxy.Config{
		ModelList:       modelList(cfg, backend),
		GeneralSettings: proxy.GeneralSettings{MasterKey: masterKey},
	}
	srv, err := proxy.New(pcfg, slog.New(slog.NewTextHandler(gollmLogWriter{}, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		return nil, fmt.Errorf("gollm proxy: %w", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("gollm proxy listen: %w", err)
	}
	httpSrv := &http.Server{Handler: srv}
	go func() {
		if serveErr := httpSrv.Serve(ln); serveErr != nil && serveErr != http.ErrServerClosed {
			log.Printf("[harness] warn: model proxy exited: %v", serveErr)
		}
	}()

	baseURL := "http://" + ln.Addr().String()
	os.Setenv("ANTHROPIC_BASE_URL", baseURL)
	os.Setenv("ANTHROPIC_AUTH_TOKEN", masterKey)
	if cfg.prWriter != "" {
		// Claude Code's background/small-model traffic goes to the run's cheap
		// writer model instead of a claude-* id only the wildcard entry serves.
		os.Setenv("ANTHROPIC_SMALL_FAST_MODEL", cfg.prWriter)
	}
	log.Printf("[harness] model proxy: rewriting claude traffic to %s/* via %s", backend, baseURL)

	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}, nil
}

// backendPrefix resolves the gollm provider prefix for the run's credentials,
// materializing credential files where a backend expects them:
//
//   - OPENAI_API_KEY            → openai/   (metered API)
//   - CODEX_AUTH_JSON           → chatgpt/  (ChatGPT subscription; auth.json
//     materialized at ~/.codex/auth.json so gollm can persist refreshed tokens)
//   - GOOGLE_PROJECT_CREDENTIALS → vertex/  (service account, project derived
//     from the JSON; GOOGLE_APPLICATION_CREDENTIALS points at the file)
//   - GEMINI_API_KEY / GOOGLE_API_KEY / ANTIGRAVITY_API_KEY → gemini/
func backendPrefix(cfg config) (string, error) {
	switch cfg.provider {
	case providerOpenAI:
		if os.Getenv("OPENAI_API_KEY") != "" {
			return "openai", nil
		}
		if authJSON := os.Getenv("CODEX_AUTH_JSON"); authJSON != "" {
			if materializeSecret(codexAuthPath(), authJSON, "ChatGPT auth.json") {
				// The provider prefers the file (rotated refresh tokens persist);
				// the env copy stays as its fallback.
				os.Setenv("CHATGPT_AUTH_FILE", codexAuthPath())
			}
			return "chatgpt", nil
		}
		return "", fmt.Errorf("openai provider selected but neither OPENAI_API_KEY nor CODEX_AUTH_JSON is set")
	case providerGemini:
		if creds := os.Getenv("GOOGLE_PROJECT_CREDENTIALS"); creds != "" {
			path := geminiCredentialsPath()
			if !materializeSecret(path, creds, "Google credentials") {
				return "", fmt.Errorf("could not materialize Google credentials")
			}
			os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", path)
			return "vertex", nil
		}
		// Legacy API-key envs; gollm's gemini provider reads GEMINI_API_KEY /
		// GOOGLE_API_KEY itself, so only the antigravity spelling needs mirroring.
		if os.Getenv("GEMINI_API_KEY") == "" && os.Getenv("GOOGLE_API_KEY") == "" {
			if key := os.Getenv("ANTIGRAVITY_API_KEY"); key != "" {
				os.Setenv("GEMINI_API_KEY", key)
			}
		}
		return "gemini", nil
	default:
		return "", fmt.Errorf("provider %s does not use the model proxy", cfg.provider)
	}
}

// modelList declares the aliases the claude CLI will request: the task model,
// the writer model (when distinct), and a claude-* wildcard so the CLI's
// internal background calls (which default to Anthropic model ids) land on
// the run's cheap model instead of failing.
func modelList(cfg config, backend string) []proxy.ModelEntry {
	entry := func(alias, model string) proxy.ModelEntry {
		return proxy.ModelEntry{
			ModelName: alias,
			Params:    proxy.ModelParams{Model: backend + "/" + model},
		}
	}

	cheap := cfg.prWriter
	if cheap == "" {
		cheap = cfg.model
	}

	list := []proxy.ModelEntry{entry(cfg.model, cfg.model)}
	if cfg.prWriter != "" && cfg.prWriter != cfg.model {
		list = append(list, entry(cfg.prWriter, cfg.prWriter))
	}
	list = append(list, entry("claude-*", cheap))
	return list
}

// randomKey mints the proxy's per-run master key.
func randomKey() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate proxy key: %w", err)
	}
	return "sk-bandolier-" + hex.EncodeToString(b[:]), nil
}

// gollmLogWriter routes the proxy's slog output into the harness log (and
// thus the transcript) tagged as harness context.
type gollmLogWriter struct{}

func (gollmLogWriter) Write(p []byte) (int, error) {
	log.Printf("[harness] gollm: %s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}
