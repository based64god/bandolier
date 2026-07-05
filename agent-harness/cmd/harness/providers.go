package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// ── Provider detection ────────────────────────────────────────────────────────

type providerKind int

const (
	providerNone      providerKind = iota
	providerAnthropic              // direct Anthropic API or Claude subscription OAuth (claude CLI)
	providerBedrock                // AWS Bedrock (claude CLI)
	providerOpenAI                 // OpenAI API or ChatGPT subscription (codex CLI)
	providerGemini                 // Google Gemini models via the Antigravity CLI (agy)
)

func detectProvider() providerKind {
	if os.Getenv("CLAUDE_CODE_USE_BEDROCK") == "1" {
		return providerBedrock
	}
	if os.Getenv("AWS_ACCESS_KEY_ID") != "" && os.Getenv("AWS_SECRET_ACCESS_KEY") != "" {
		return providerBedrock
	}
	// CLAUDE_CODE_OAUTH_TOKEN is a Claude subscription token from
	// `claude setup-token`; the claude CLI reads it directly from the env.
	if os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("CLAUDE_CODE_OAUTH_TOKEN") != "" {
		return providerAnthropic
	}
	// CODEX_AUTH_JSON carries the contents of `codex login`'s auth.json for
	// ChatGPT-subscription users; buildEnv materializes it at ~/.codex/auth.json.
	if os.Getenv("OPENAI_API_KEY") != "" || os.Getenv("CODEX_AUTH_JSON") != "" {
		return providerOpenAI
	}
	if os.Getenv("GOOGLE_PROJECT_CREDENTIALS") != "" ||
		os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" ||
		os.Getenv("ANTIGRAVITY_API_KEY") != "" ||
		os.Getenv("GEMINI_API_KEY") != "" ||
		os.Getenv("GOOGLE_API_KEY") != "" {
		return providerGemini
	}
	return providerNone
}

// String renders a providerKind for diagnostics.
func (p providerKind) String() string {
	switch p {
	case providerAnthropic:
		return "anthropic"
	case providerBedrock:
		return "bedrock"
	case providerOpenAI:
		return "openai"
	case providerGemini:
		return "gemini"
	default:
		return "none"
	}
}

// logProvider records the active provider (and model) at the start of a run.
func logProvider(cfg config) {
	switch cfg.provider {
	case providerBedrock:
		log.Printf("[harness] provider: AWS Bedrock (region=%s, model=%s)", os.Getenv("AWS_REGION"), cfg.model)
	case providerAnthropic:
		log.Printf("[harness] provider: Anthropic API (model=%s)", cfg.model)
	case providerOpenAI:
		log.Printf("[harness] provider: OpenAI Codex (model=%s)", cfg.model)
	case providerGemini:
		log.Printf("[harness] provider: Google Antigravity / Gemini (model=%s)", cfg.model)
	default:
		log.Printf("[harness] warn: no LLM credentials found — the agent will likely fail")
	}
}

// ── Subprocess environment ────────────────────────────────────────────────────

func buildEnv(provider providerKind) []string {
	env := os.Environ()
	switch provider {
	case providerBedrock:
		env = setEnvIfMissing(env, "CLAUDE_CODE_USE_BEDROCK", "1")
	case providerOpenAI:
		env = setupCodexCredentials(env)
	case providerGemini:
		// agy (Antigravity CLI) authenticates against a Google Cloud project via
		// Application Default Credentials. The server injects the project
		// credentials JSON as GOOGLE_PROJECT_CREDENTIALS; materialize it and point
		// agy at it. Legacy *_API_KEY values are still honored as a fallback.
		env = setupGeminiCredentials(env)
	}
	return env
}

// codexAuthPath is where the harness materializes `codex login`'s auth.json
// (injected as CODEX_AUTH_JSON) — ~/.codex/auth.json, where the Codex CLI
// looks for its ChatGPT-subscription session.
func codexAuthPath() string {
	return filepath.Join(homeDir(), ".codex", "auth.json")
}

// homeDir returns the current user's home directory, falling back to /root when
// it can't be determined (the harness runs as root in its container).
func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "/root"
	}
	return home
}

// materializeSecret writes secret contents to path, creating the parent
// directory 0700 and the file 0600. On any failure it logs a warning naming
// what failed via label and returns false so callers can warn-and-continue.
func materializeSecret(path, contents, label string) bool {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.Printf("[harness] warn: could not create %s: %v", filepath.Dir(path), err)
		return false
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		log.Printf("[harness] warn: could not write %s: %v", label, err)
		return false
	}
	return true
}

// setupCodexCredentials prepares Codex CLI authentication. With OPENAI_API_KEY
// it mirrors the key to CODEX_API_KEY (which some Codex versions read instead,
// so either name works). With CODEX_AUTH_JSON — the contents of `codex login`'s
// auth.json, for ChatGPT-subscription users — it writes the file to
// ~/.codex/auth.json where the CLI expects it. The server injects exactly one
// of the two; the API key wins if both are somehow present.
func setupCodexCredentials(env []string) []string {
	if key := os.Getenv("OPENAI_API_KEY"); key != "" {
		return setEnvIfMissing(env, "CODEX_API_KEY", key)
	}
	authJSON := os.Getenv("CODEX_AUTH_JSON")
	if authJSON == "" {
		return env
	}
	materializeSecret(codexAuthPath(), authJSON, "Codex auth.json")
	return env
}

// geminiCredentialsPath is where the harness materializes the Google project
// credentials JSON. It lives under ~/.gemini so agy finds it alongside its own
// config; GOOGLE_APPLICATION_CREDENTIALS points the google-genai auth at it.
func geminiCredentialsPath() string {
	return filepath.Join(homeDir(), ".gemini", "credentials.json")
}

// setupGeminiCredentials writes the Google project credentials JSON (injected as
// GOOGLE_PROJECT_CREDENTIALS) to ~/.gemini/credentials.json and sets the env
// agy needs to authenticate against the project: ADC via
// GOOGLE_APPLICATION_CREDENTIALS, Vertex mode, and the project id parsed out of
// the JSON. When no credentials JSON is present it falls back to mirroring a
// legacy GEMINI_API_KEY/GOOGLE_API_KEY into ANTIGRAVITY_API_KEY.
func setupGeminiCredentials(env []string) []string {
	creds := os.Getenv("GOOGLE_PROJECT_CREDENTIALS")
	if creds == "" {
		if os.Getenv("ANTIGRAVITY_API_KEY") == "" {
			if key := os.Getenv("GEMINI_API_KEY"); key != "" {
				env = setEnvIfMissing(env, "ANTIGRAVITY_API_KEY", key)
			} else if key := os.Getenv("GOOGLE_API_KEY"); key != "" {
				env = setEnvIfMissing(env, "ANTIGRAVITY_API_KEY", key)
			}
		}
		return env
	}

	path := geminiCredentialsPath()
	if !materializeSecret(path, creds, "Gemini credentials") {
		return env
	}

	env = setEnvIfMissing(env, "GOOGLE_APPLICATION_CREDENTIALS", path)
	env = setEnvIfMissing(env, "GOOGLE_GENAI_USE_VERTEXAI", "true")
	// Target the project named in the credentials so a second secret isn't needed.
	if proj := projectIDFromCredentials(creds); proj != "" {
		env = setEnvIfMissing(env, "GOOGLE_CLOUD_PROJECT", proj)
	}
	return env
}

// projectIDFromCredentials extracts the project id from a Google credentials
// JSON (service-account key or ADC), preferring project_id and falling back to
// quota_project_id. Returns "" if the JSON can't be parsed or has neither.
func projectIDFromCredentials(creds string) string {
	var parsed struct {
		ProjectID      string `json:"project_id"`
		QuotaProjectID string `json:"quota_project_id"`
	}
	if err := json.Unmarshal([]byte(creds), &parsed); err != nil {
		return ""
	}
	if parsed.ProjectID != "" {
		return parsed.ProjectID
	}
	return parsed.QuotaProjectID
}

func setEnvIfMissing(env []string, key, value string) []string {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return env
		}
	}
	return append(env, prefix+value)
}

// ── Writer models (out-of-band PR/issue copy) ─────────────────────────────────

// writerExecFn runs the out-of-band writer model on a TITLE/BODY prompt and
// returns its raw reply text. Only the CLI invocation differs per provider; the
// shared generateWriterContent wraps the timeout, model fallback, and parsing
// around it.
type writerExecFn func(ctx context.Context, cfg config, writerModel, prompt string) (string, error)

// writerExecFor selects the raw writer invocation for the run's provider: codex
// for OpenAI, agy for Gemini, and the claude CLI otherwise.
func writerExecFor(provider providerKind) writerExecFn {
	switch provider {
	case providerOpenAI:
		return writerExecCodex
	case providerGemini:
		return writerExecGemini
	default:
		return writerExecClaude
	}
}
