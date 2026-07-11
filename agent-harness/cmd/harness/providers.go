package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
)

// ── Provider detection ────────────────────────────────────────────────────────

type providerKind int

const (
	providerNone      providerKind = iota
	providerAnthropic              // direct Anthropic API or Claude subscription OAuth
	providerBedrock                // AWS Bedrock (claude CLI native)
	providerOpenAI                 // OpenAI API key or ChatGPT subscription, via the embedded gollm proxy
	providerGemini                 // Google Gemini / Vertex, via the embedded gollm proxy
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
	// ChatGPT-subscription users; the model proxy's chatgpt backend consumes it.
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
		if os.Getenv("OPENAI_API_KEY") == "" {
			log.Printf("[harness] provider: ChatGPT subscription via model proxy (model=%s)", cfg.model)
		} else {
			log.Printf("[harness] provider: OpenAI API via model proxy (model=%s)", cfg.model)
		}
	case providerGemini:
		if os.Getenv("GOOGLE_PROJECT_CREDENTIALS") != "" {
			log.Printf("[harness] provider: Google Vertex AI via model proxy (model=%s)", cfg.model)
		} else {
			log.Printf("[harness] provider: Google Gemini via model proxy (model=%s)", cfg.model)
		}
	default:
		log.Printf("[harness] warn: no LLM credentials found — the agent will likely fail")
	}
}

// ── Subprocess environment ────────────────────────────────────────────────────

// buildEnv assembles the environment for a claude invocation. Proxy-routed
// providers need nothing extra here: startModelProxy exported
// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN process-wide, so os.Environ()
// already carries the rewrite.
func buildEnv(provider providerKind) []string {
	env := os.Environ()
	if provider == providerBedrock {
		env = setEnvIfMissing(env, "CLAUDE_CODE_USE_BEDROCK", "1")
	}
	return env
}

// codexAuthPath is where the harness materializes `codex login`'s auth.json
// (injected as CODEX_AUTH_JSON) — ~/.codex/auth.json, the gollm chatgpt
// backend's default location, so refreshed tokens persist for the run.
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

// geminiCredentialsPath is where the harness materializes the Google project
// credentials JSON (injected as GOOGLE_PROJECT_CREDENTIALS);
// GOOGLE_APPLICATION_CREDENTIALS points the gollm vertex backend at it.
func geminiCredentialsPath() string {
	return filepath.Join(homeDir(), ".gemini", "credentials.json")
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
