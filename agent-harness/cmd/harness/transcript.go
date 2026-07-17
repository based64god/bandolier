package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ── Transcript capture ─────────────────────────────────────────────────────────

// syncBuffer is a concurrency-safe buffer; both the main flow and the signal
// goroutine write to the transcript via the log package.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// transcript accumulates everything written to the pod log (harness lines via
// the log package + Claude's assistant text); stdoutTee fans assistant output to
// both real stdout and the transcript.
var (
	transcript           = &syncBuffer{}
	stdoutTee  io.Writer = os.Stdout
)

// harnessContractVersion is this build's server↔harness contract version,
// reported on the ingest callback so Bandolier can warn a repo admin whose
// custom agent image was built from harness source older than what the server
// now expects of it. Pinned in wire-contract.json (repo root) and asserted
// against it by wire_contract_test.go; bump only together with that file.
const harnessContractVersion = 2

// outputPRURL / outputIssueURL hold the run's structured output (the pull
// request or issue the harness produced). They're reported to Bandolier via the
// ingest callback so a finished run's output is recoverable from the database
// even after the pod — and its logs — are gone.
var (
	outputPRURL    string
	outputIssueURL string
)

// uploadTranscript best-effort POSTs the run's structured output (its PR/issue
// URL) and captured transcript to Bandolier's ingest callback. The output is
// persisted on the run row so it survives pod-log loss; the transcript is stored
// in object storage when the server has a bucket configured. Reporting the
// output is the point of this call — it runs for every run, not just when S3
// artifacts are enabled. No-op only when the ingest env isn't injected.
// `failed` reports the run's terminal state so the persisted row can show
// Succeeded/Failed after the pod (whose phase is the live source) is gone.
func uploadTranscript(failed bool) {
	url := os.Getenv("BANDOLIER_INGEST_URL")
	if url == "" || bando.token == "" || bando.job == "" {
		return
	}

	body := []byte(transcript.String())
	// Use a fresh context: the run's context may already be canceled (SIGTERM).
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := bando.newRequest(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("[harness] warn: transcript request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	// Report this build's contract version so the server can flag repos whose
	// custom agent image is out of date (absence of the header marks builds
	// older than version reporting itself).
	req.Header.Set("X-Bandolier-Harness-Contract", fmt.Sprintf("%d", harnessContractVersion))
	// Report the run's terminal state so it's persisted on the run row: the pod's
	// phase is the live source, but it vanishes with the pod. Mirrors the values
	// of the pod phase the server would otherwise read (Succeeded/Failed).
	status := "Succeeded"
	if failed {
		status = "Failed"
	}
	req.Header.Set("X-Bandolier-Status", status)
	// Report the run's structured output alongside the transcript so it's
	// persisted durably — pod logs (the live source) vanish with the pod.
	if outputPRURL != "" {
		req.Header.Set("X-Bandolier-PR-URL", outputPRURL)
	}
	if outputIssueURL != "" {
		req.Header.Set("X-Bandolier-Issue-URL", outputIssueURL)
	}
	// Report the run's final token usage (the most recent marker in the
	// transcript) so it's persisted on the run row and survives pod-log loss.
	if tokens := latestTokenMarker(transcript.String()); tokens != "" {
		req.Header.Set("X-Bandolier-Tokens", tokens)
	}

	resp, err := bando.do(req)
	if err != nil {
		log.Printf("[harness] warn: transcript upload failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("[harness] warn: transcript upload status %d", resp.StatusCode)
		return
	}
	log.Printf("[harness] transcript persisted (%d bytes)", len(body))
}

// maxParentContextBytes caps how much of the parent run's transcript is folded
// into a resumed run's prompt. The tail is kept — it holds the parent's final
// state and conclusions — and the cap keeps the assembled prompt well under the
// kernel's per-argument exec limit (~128 KiB), since the task is passed to the
// agent CLI as a single argv element.
const maxParentContextBytes = 100_000

// fetchParentContext downloads the parent run's persisted transcript from
// Bandolier's context endpoint (set only for resumed runs), authenticated with
// the same per-job token as the ingest callback. Returns "" when there is no
// context to be had — no endpoint configured, no parent transcript persisted,
// or any error — because a resume must still run without it.
func fetchParentContext(ctx context.Context, cfg config) string {
	url := cfg.contextURL
	if url == "" || bando.token == "" || bando.job == "" {
		return ""
	}

	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := bando.get(reqCtx, url)
	if err != nil {
		log.Printf("[harness] warn: parent context fetch failed: %v", err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("[harness] no parent context available (status %d)", resp.StatusCode)
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		log.Printf("[harness] warn: parent context read failed: %v", err)
		return ""
	}
	return string(body)
}

// withParentContext folds the parent run's transcript into the task so the
// resumed agent starts with the full context of the run it continues. When the
// transcript exceeds the cap, the head is dropped (the tail carries the
// parent's final state) and the truncation is called out in place.
func withParentContext(task, transcript string) string {
	transcript = strings.TrimSpace(transcript)
	if transcript == "" {
		return task
	}
	if len(transcript) > maxParentContextBytes {
		cut := len(transcript) - maxParentContextBytes
		transcript = "…(earlier transcript truncated)…\n" + transcript[cut:]
	}
	return fmt.Sprintf(`## Context from the parent run

This task resumes a previous agent run. That run's transcript follows between the markers — use it to understand what was already done, and why, before acting on the follow-up request.

<parent-run-transcript>
%s
</parent-run-transcript>

## Follow-up request

%s`, transcript, task)
}
