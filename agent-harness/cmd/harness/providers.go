package main

import (
	"log"
	"os"
	"strings"
)

// ── Provider detection ────────────────────────────────────────────────────────
//
// Two tiers of provider. The claude CLI speaks Anthropic and Bedrock natively
// (full prompt-cache and thinking fidelity), so those run directly. Everything
// else — OpenAI, Gemini, and the ~90 other providers gollm supports — is
// proxied: the server names the gollm backend in BANDOLIER_LLM_PROVIDER and
// injects that backend's credential env vars, and the embedded gollm proxy
// rewrites the claude CLI's Anthropic-format traffic to it. The harness itself
// no longer knows any proxied provider by name.

type providerKind int

const (
	providerNone      providerKind = iota
	providerAnthropic              // direct Anthropic API or Claude subscription OAuth (claude CLI native)
	providerBedrock                // AWS Bedrock (claude CLI native)
	providerGollm                  // any gollm-proxied provider named by BANDOLIER_LLM_PROVIDER
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
	// Every proxied provider (OpenAI, Gemini, Vertex, ChatGPT subscription, and
	// the rest of gollm's roster) is selected the same way: the server sets
	// BANDOLIER_LLM_PROVIDER to the gollm backend id and injects its credential
	// env vars.
	if os.Getenv("BANDOLIER_LLM_PROVIDER") != "" {
		return providerGollm
	}
	return providerNone
}

// gollmBackend returns the gollm provider id the proxy routes to for a
// providerGollm run.
func gollmBackend() string {
	return os.Getenv("BANDOLIER_LLM_PROVIDER")
}

// String renders a providerKind for diagnostics.
func (p providerKind) String() string {
	switch p {
	case providerAnthropic:
		return "anthropic"
	case providerBedrock:
		return "bedrock"
	case providerGollm:
		return "gollm:" + gollmBackend()
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
	case providerGollm:
		log.Printf("[harness] provider: %s via model proxy (model=%s)", gollmBackend(), cfg.model)
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

func setEnvIfMissing(env []string, key, value string) []string {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return env
		}
	}
	return append(env, prefix+value)
}
