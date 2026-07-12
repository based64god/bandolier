package main

import (
	"os"
	"strings"
	"testing"
)

// covProvClearEnv unsets key for the test and restores its prior state after.
// buildEnv/getenvDefault must see a genuinely-absent variable: t.Setenv can only
// assign a value, and an empty "KEY=" entry still satisfies setEnvIfMissing's
// prefix check (so buildEnv would skip appending) and reads as unset to
// getenvDefault only via the empty-string branch, not the missing-key branch.
func covProvClearEnv(t *testing.T, key string) {
	t.Helper()
	orig, had := os.LookupEnv(key)
	os.Unsetenv(key)
	t.Cleanup(func() {
		if had {
			os.Setenv(key, orig)
		} else {
			os.Unsetenv(key)
		}
	})
}

// covProvCountEnv counts how many entries of env exactly equal want.
func covProvCountEnv(env []string, want string) int {
	n := 0
	for _, e := range env {
		if e == want {
			n++
		}
	}
	return n
}

func TestCovProvIssueOutput(t *testing.T) {
	if !(config{outputType: "issue"}).issueOutput() {
		t.Error("issueOutput() = false for outputType=issue, want true")
	}
	// Anything other than the exact "issue" string is a PR-producing run.
	for _, ot := range []string{"pr", "", "Issue", "issues", "ISSUE"} {
		if (config{outputType: ot}).issueOutput() {
			t.Errorf("issueOutput() = true for outputType=%q, want false", ot)
		}
	}
}

func TestCovProvWritesPRCopy(t *testing.T) {
	// Every proxy-routed (gollm) run generates PR copy, with or without a
	// dedicated writer model.
	if !(config{provider: providerGollm}).writesPRCopy() {
		t.Error("writesPRCopy() = false for gollm with no writer, want true")
	}
	if !(config{provider: providerGollm, prWriter: "gpt-mini"}).writesPRCopy() {
		t.Error("writesPRCopy() = false for gollm with a writer, want true")
	}

	// A native (non-gollm) run generates PR copy only when a writer model is
	// configured, so it isn't billed to the task model.
	if !(config{provider: providerAnthropic, prWriter: "claude-haiku"}).writesPRCopy() {
		t.Error("writesPRCopy() = false for a Claude run with a writer model, want true")
	}
	if !(config{provider: providerBedrock, prWriter: "claude-haiku"}).writesPRCopy() {
		t.Error("writesPRCopy() = false for a Bedrock run with a writer model, want true")
	}

	// Native provider, no writer → no out-of-band PR copy.
	for _, p := range []providerKind{providerAnthropic, providerBedrock, providerNone} {
		if (config{provider: p}).writesPRCopy() {
			t.Errorf("writesPRCopy() = true for non-gollm provider %v with no writer, want false", p)
		}
	}
}

func TestCovProvProviderKindString(t *testing.T) {
	if got := providerAnthropic.String(); got != "anthropic" {
		t.Errorf("providerAnthropic.String() = %q, want anthropic", got)
	}
	if got := providerBedrock.String(); got != "bedrock" {
		t.Errorf("providerBedrock.String() = %q, want bedrock", got)
	}
	if got := providerNone.String(); got != "none" {
		t.Errorf("providerNone.String() = %q, want none", got)
	}

	// The gollm rendering carries the backend id named by BANDOLIER_LLM_PROVIDER.
	t.Setenv("BANDOLIER_LLM_PROVIDER", "openai")
	if got := providerGollm.String(); got != "gollm:openai" {
		t.Errorf("providerGollm.String() = %q, want gollm:openai", got)
	}
	t.Setenv("BANDOLIER_LLM_PROVIDER", "vertex")
	if got := providerGollm.String(); got != "gollm:vertex" {
		t.Errorf("providerGollm.String() = %q, want gollm:vertex", got)
	}
}

func TestCovProvLogProvider(t *testing.T) {
	clearConfigEnv(t)

	// Bedrock: the region (from AWS_REGION) and model land in an AWS Bedrock line.
	t.Setenv("AWS_REGION", "us-west-2")
	out := captureHarnessLog(t, func() {
		logProvider(config{provider: providerBedrock, model: "claude-bedrock"})
	})
	if !strings.Contains(out, "AWS Bedrock") || !strings.Contains(out, "us-west-2") || !strings.Contains(out, "claude-bedrock") {
		t.Errorf("bedrock log = %q, want AWS Bedrock / region / model", out)
	}

	// Anthropic API.
	out = captureHarnessLog(t, func() {
		logProvider(config{provider: providerAnthropic, model: "claude-anthropic"})
	})
	if !strings.Contains(out, "Anthropic API") || !strings.Contains(out, "claude-anthropic") {
		t.Errorf("anthropic log = %q, want Anthropic API / model", out)
	}

	// Gollm: the backend id (BANDOLIER_LLM_PROVIDER) plus the model-proxy note.
	t.Setenv("BANDOLIER_LLM_PROVIDER", "openai")
	out = captureHarnessLog(t, func() {
		logProvider(config{provider: providerGollm, model: "gpt-proxied"})
	})
	if !strings.Contains(out, "via model proxy") || !strings.Contains(out, "openai") || !strings.Contains(out, "gpt-proxied") {
		t.Errorf("gollm log = %q, want backend / via model proxy / model", out)
	}

	// None: the no-credentials warning.
	out = captureHarnessLog(t, func() {
		logProvider(config{provider: providerNone})
	})
	if !strings.Contains(out, "no LLM credentials") {
		t.Errorf("none log = %q, want the no-credentials warning", out)
	}
}

func TestCovProvBuildEnv(t *testing.T) {
	// Absent → the Bedrock flag is appended for a Bedrock run.
	covProvClearEnv(t, "CLAUDE_CODE_USE_BEDROCK")
	if env := buildEnv(providerBedrock); !containsEnv(env, "CLAUDE_CODE_USE_BEDROCK=1") {
		t.Error("buildEnv(providerBedrock) did not append CLAUDE_CODE_USE_BEDROCK=1")
	}

	// A non-Bedrock (Anthropic) run never sets the flag.
	if env := buildEnv(providerAnthropic); containsEnv(env, "CLAUDE_CODE_USE_BEDROCK=1") {
		t.Error("buildEnv(providerAnthropic) set the Bedrock flag, want absent")
	}

	// Idempotent: when the flag is already present it is not duplicated.
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	if n := covProvCountEnv(buildEnv(providerBedrock), "CLAUDE_CODE_USE_BEDROCK=1"); n != 1 {
		t.Errorf("CLAUDE_CODE_USE_BEDROCK=1 appears %d times, want exactly 1 (idempotent)", n)
	}
}

func TestCovProvNeedsModelProxy(t *testing.T) {
	if !needsModelProxy(providerGollm) {
		t.Error("needsModelProxy(providerGollm) = false, want true")
	}
	// Anthropic and Bedrock speak the CLI's native protocols; none has no proxy.
	for _, p := range []providerKind{providerNone, providerAnthropic, providerBedrock} {
		if needsModelProxy(p) {
			t.Errorf("needsModelProxy(%v) = true, want false", p)
		}
	}
}

func TestCovProvGollmLogWriterWrite(t *testing.T) {
	payload := []byte("level=WARN msg=\"rate limited\"\n")
	var (
		n   int
		err error
	)
	out := captureHarnessLog(t, func() {
		n, err = gollmLogWriter{}.Write(payload)
	})
	if err != nil {
		t.Fatalf("Write returned err %v, want nil", err)
	}
	// Write must report the full payload consumed (including the trailing newline)
	// so slog sees a complete, non-short write.
	if n != len(payload) {
		t.Errorf("Write returned n=%d, want %d (full payload length)", n, len(payload))
	}
	if !strings.Contains(out, "[harness] gollm: level=WARN msg=\"rate limited\"") {
		t.Errorf("log = %q, want the payload tagged [harness] gollm:", out)
	}
	// The payload's trailing newline is trimmed before logging, so log.Printf's own
	// newline is the only one — the line is not double-spaced.
	if strings.Contains(out, "rate limited\"\n\n") {
		t.Errorf("log doubled the trailing newline: %q", out)
	}
}

func TestCovProvGetenvDefault(t *testing.T) {
	const key = "COVPROV_GETENV_DEFAULT_KEY"

	// A set, non-empty value wins over the default.
	t.Setenv(key, "from-env")
	if got := getenvDefault(key, "fallback"); got != "from-env" {
		t.Errorf("getenvDefault with a value set = %q, want from-env", got)
	}

	// An empty value falls back to the default.
	t.Setenv(key, "")
	if got := getenvDefault(key, "fallback"); got != "fallback" {
		t.Errorf("getenvDefault with an empty value = %q, want fallback", got)
	}

	// A genuinely-unset key falls back to the default.
	covProvClearEnv(t, key)
	if got := getenvDefault(key, "fallback"); got != "fallback" {
		t.Errorf("getenvDefault with an unset key = %q, want fallback", got)
	}
}
