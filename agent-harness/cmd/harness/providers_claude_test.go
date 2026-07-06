package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// captureHarnessLog redirects the log package (the transcript sink) to a buffer
// for the duration of fn and returns what was written. Flags are cleared so the
// captured lines are just the tagged text, without a timestamp prefix.
func captureHarnessLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	origOut := log.Writer()
	origFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(origOut)
		log.SetFlags(origFlags)
	}()
	fn()
	return buf.String()
}

// The one-shot log path must record a tool's output so the transcript (and the
// log modal) can show it, matching the interactive proxy. Each line is ←-tagged
// so the frontend can fold the whole result behind a nested expander.
func TestHandleClaudeEventLogsToolResult(t *testing.T) {
	out := captureHarnessLog(t, func() {
		handleClaudeEvent([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"line one\nline two"}]}}`))
	})
	for _, want := range []string{"[harness]   ← line one", "[harness]   ← line two"} {
		if !strings.Contains(out, want) {
			t.Errorf("log = %q, missing %q", out, want)
		}
	}
}

func TestLogToolResult(t *testing.T) {
	// Every line is marked, so a multi-line result folds as one block.
	if got, want := captureHarnessLog(t, func() { logToolResult("alpha\nbeta\n") }),
		"[harness]   ← alpha\n[harness]   ← beta\n"; got != want {
		t.Errorf("logToolResult multi-line = %q, want %q", got, want)
	}

	// Blank / whitespace-only output emits nothing, so a resultless call stays a
	// one-liner rather than gaining an empty expander.
	if out := captureHarnessLog(t, func() { logToolResult("   \n") }); out != "" {
		t.Errorf("blank result logged %q, want empty", out)
	}
}
