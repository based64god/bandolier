package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureCombined must fold both stdout and stderr into the returned string, so
// a caller inspecting the combined output (e.g. a gh "already exists" notice on
// stderr) sees everything the command emitted regardless of stream.
func TestCovMiscCaptureCombinedBothStreams(t *testing.T) {
	out, err := captureCombined(context.Background(), t.TempDir(), "sh", "-c", "echo out; echo err >&2")
	if err != nil {
		t.Fatalf("captureCombined returned error for a zero-exit command: %v", err)
	}
	if !strings.Contains(out, "out") {
		t.Errorf("combined output %q missing stdout line 'out'", out)
	}
	if !strings.Contains(out, "err") {
		t.Errorf("combined output %q missing stderr line 'err'", out)
	}
}

// A non-zero exit must surface as a non-nil error while still handing back
// whatever the command managed to write — the caller distinguishes a real
// failure from a benign notice by reading that captured output.
func TestCovMiscCaptureCombinedNonZeroExit(t *testing.T) {
	out, err := captureCombined(context.Background(), t.TempDir(), "sh", "-c", "echo captured; exit 3")
	if err == nil {
		t.Fatalf("captureCombined error = nil for a non-zero exit, want non-nil")
	}
	if !strings.Contains(out, "captured") {
		t.Errorf("combined output %q missing 'captured' on the failing command", out)
	}
}

// covMiscSwapBando installs a temporary Bandolier client (matching the
// transcript_test.go swap pattern) and restores the original when the test ends.
func covMiscSwapBando(t *testing.T, token, job string, http *http.Client) {
	t.Helper()
	orig := bando
	bando = &bandolierClient{token: token, job: job, http: http}
	t.Cleanup(func() { bando = orig })
}

// A 200 with a body from the context endpoint must be returned verbatim so the
// resumed run can fold the parent transcript into its prompt.
func TestCovMiscFetchParentContextOK(t *testing.T) {
	const bodyText = "parent transcript body"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("Authorization = %q, want Bearer tok", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(bodyText))
	}))
	defer srv.Close()
	covMiscSwapBando(t, "tok", "job-1", srv.Client())

	got := fetchParentContext(context.Background(), config{contextURL: srv.URL})
	if got != bodyText {
		t.Errorf("fetchParentContext = %q, want %q", got, bodyText)
	}
}

// A non-200 status means no parent context is available; fetchParentContext must
// swallow it and return "" so a resume still runs without the context.
func TestCovMiscFetchParentContextNon200(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	covMiscSwapBando(t, "tok", "job-1", srv.Client())

	if got := fetchParentContext(context.Background(), config{contextURL: srv.URL}); got != "" {
		t.Errorf("fetchParentContext on 404 = %q, want empty", got)
	}
	if !hit {
		t.Error("expected the endpoint to be hit for a configured contextURL")
	}
}

// An empty contextURL means there's nothing to fetch: fetchParentContext must
// return "" without issuing any request.
func TestCovMiscFetchParentContextNoURL(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()
	// Credentials present, but no URL configured.
	covMiscSwapBando(t, "tok", "job-1", srv.Client())

	if got := fetchParentContext(context.Background(), config{contextURL: ""}); got != "" {
		t.Errorf("fetchParentContext with empty URL = %q, want empty", got)
	}
	if hit {
		t.Error("no request should be issued when contextURL is empty")
	}
}

// Missing per-job credentials (no token) also short-circuits to "" without a
// request — the callback is unauthenticated and can't be made.
func TestCovMiscFetchParentContextNoToken(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()
	covMiscSwapBando(t, "", "job-1", srv.Client())

	if got := fetchParentContext(context.Background(), config{contextURL: srv.URL}); got != "" {
		t.Errorf("fetchParentContext with empty token = %q, want empty", got)
	}
	if hit {
		t.Error("no request should be issued when the job token is empty")
	}
}

// onSlashCommands is a deliberate no-op on the log sink (the interactive proxy
// consumes slash commands, not the transcript renderer): calling it must not
// panic and must emit nothing to the transcript.
func TestCovMiscOnSlashCommandsNoOp(t *testing.T) {
	out := captureHarnessLog(t, func() {
		newClaudeLogSink().onSlashCommands([]string{"commit", "review"})
	})
	if out != "" {
		t.Errorf("onSlashCommands emitted %q, want nothing", out)
	}
}

// onThinking must render the thought into the transcript: the first line tagged
// (thinking) and continuation lines indented, all under [harness].
func TestCovMiscOnThinkingLogsThought(t *testing.T) {
	out := captureHarnessLog(t, func() {
		newClaudeLogSink().onThinking("first thought\nsecond line", "")
	})
	if !strings.Contains(out, "[harness] (thinking) first thought") {
		t.Errorf("onThinking output missing tagged first line; got:\n%s", out)
	}
	if !strings.Contains(out, "[harness]     second line") {
		t.Errorf("onThinking output missing indented continuation; got:\n%s", out)
	}
}

// onResult renders the terminal lifecycle line; it must distinguish a clean
// finish from an errored one and carry the turn count in both branches.
func TestCovMiscOnResultBothBranches(t *testing.T) {
	okOut := captureHarnessLog(t, func() {
		newClaudeLogSink().onResult(claudeEvent{IsError: false, NumTurns: 4})
	})
	if !strings.Contains(okOut, "[harness] claude finished (turns=4)") {
		t.Errorf("onResult clean finish missing expected line; got:\n%s", okOut)
	}

	errOut := captureHarnessLog(t, func() {
		newClaudeLogSink().onResult(claudeEvent{IsError: true, NumTurns: 2})
	})
	if !strings.Contains(errOut, "[harness] claude finished with error (turns=2)") {
		t.Errorf("onResult errored finish missing expected line; got:\n%s", errOut)
	}
}
