package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"
)

// ── PR review output ──────────────────────────────────────────────────────────
//
// Review mode analyses an existing pull request read-only and produces a review
// — never code, never a branch. The agent writes its review as JSON to
// cfg.reviewFile; the harness reads it and POSTs it to Bandolier, which submits
// it to the PR in the bandolier[bot] voice (never the acting user's
// credentials). See buildReviewOutputSystemPrompt for the framing the agent
// follows, and the /api/agent-runs/review endpoint for the server side.

// reviewComment is one inline comment in a submitted review, anchored to a line
// of the PR's diff. The field names match the server endpoint's expected shape.
type reviewComment struct {
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Side      string `json:"side,omitempty"`
	StartLine int    `json:"startLine,omitempty"`
	StartSide string `json:"startSide,omitempty"`
	Body      string `json:"body"`
}

// prReview is the structured review the agent writes and the harness submits.
// `Summary` is accepted as an alias for `Body` when the agent uses it.
type prReview struct {
	Event    string          `json:"event"`
	Body     string          `json:"body"`
	Summary  string          `json:"summary,omitempty"`
	Comments []reviewComment `json:"comments,omitempty"`
}

// empty reports whether the review carries nothing to post.
func (r *prReview) empty() bool {
	return strings.TrimSpace(r.Body) == "" && len(r.Comments) == 0
}

// normalize coalesces the summary alias and defaults the verdict to COMMENT (the
// non-blocking review event), so a review missing or misusing `event` still
// posts. The server re-validates, but sending clean data keeps its logs honest.
func (r *prReview) normalize() {
	if strings.TrimSpace(r.Body) == "" && strings.TrimSpace(r.Summary) != "" {
		r.Body = r.Summary
	}
	r.Summary = ""
	switch r.Event {
	case "COMMENT", "APPROVE", "REQUEST_CHANGES":
	default:
		r.Event = "COMMENT"
	}
}

// buildReviewOutputSystemPrompt frames a review-output run: the agent reviews an
// existing pull request read-only and writes its review as JSON to reviewFile,
// which the harness submits. No branch, no commits, no PR.
func buildReviewOutputSystemPrompt(prNumber, reviewFile string) string {
	return fmt.Sprintf(`You are an AI agent that reviews a GitHub pull request and produces a REVIEW, NOT code changes.

## Your objective

Review pull request #%s. The repository is cloned and the pull request's head is checked out, so the working tree holds the proposed change. Inspect it thoroughly:
- Run `+"`gh pr diff %s`"+` to see the full diff, and `+"`gh pr view %s`"+` for the description and discussion.
- Explore the codebase read-only to ground your review in how the change fits the surrounding code.

Focus on correctness, security, and clear regressions first, then maintainability. Be specific and actionable, and anchor findings to concrete files and lines. Do not nitpick style a formatter would catch.

Do NOT modify files (other than writing the review file below), commit, push, or open a pull request — you are only reviewing.

## How to deliver the review

Write your review as JSON to the file %s (create it). Use EXACTLY this shape:

{
  "event": "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
  "body": "<overall review in markdown: a short summary, then the key points>",
  "comments": [
    { "path": "<repo-relative file>", "line": <line number in the NEW version of the file>, "body": "<comment on that line>" }
  ]
}

- Prefer "COMMENT". Use "REQUEST_CHANGES" only for genuinely blocking problems, and "APPROVE" when the change is clearly good.
- Each inline comment's "line" must be a line the diff actually adds or changes (the new / RIGHT side), or GitHub will reject it. For a multi-line span add "startLine". Use an empty list if you have no line-specific comments.
- Put everything a maintainer should know in "body"; inline comments are for pinpointing specific lines.

The harness reads that file and submits the review once you finish. Do not ask for clarification.`, prNumber, prNumber, prNumber, reviewFile)
}

// checkoutPR checks out the pull request's head so the working tree holds the
// proposed change. Best-effort: on failure (e.g. a fork the token can't reach)
// the agent still reviews via `gh pr diff`, so it never fails the run.
func checkoutPR(ctx context.Context, cfg config) {
	if cfg.reviewPRNumber == "" {
		return
	}
	log.Printf("[harness] checking out pull request #%s for review", cfg.reviewPRNumber)
	if err := runCmd(ctx, cfg.workDir, os.Environ(), "gh", "pr", "checkout", cfg.reviewPRNumber); err != nil {
		log.Printf("[harness] warn: gh pr checkout failed (%v) — reviewing via diff only", err)
	}
}

// submitReview reads the agent's review file and POSTs the review to Bandolier
// (which posts it to the PR in the bot voice). When the file is missing or
// empty, it falls back to a body-only review summarised from the transcript by
// the writer model, so a review always lands. Returns an error only when the
// submit itself fails, so the run is marked failed rather than silently
// reporting success with no review.
func submitReview(ctx context.Context, cfg config, transcript string) error {
	if cfg.reviewURL == "" {
		log.Printf("[harness] no review endpoint configured — skipping review submit")
		return nil
	}

	review := readReviewFile(cfg.reviewFile)
	if review == nil || review.empty() {
		log.Printf("[harness] no usable review file — summarising the transcript instead")
		body := generateReviewSummary(ctx, cfg, transcript)
		if strings.TrimSpace(body) == "" {
			body = "Bandolier reviewed this pull request but could not produce structured feedback; see the run logs."
		}
		review = &prReview{Event: "COMMENT", Body: body}
	}
	review.normalize()
	return postReview(ctx, cfg, review)
}

// readReviewFile reads and parses the agent's review JSON, returning nil when
// there is no usable file (absent, unreadable, or not valid JSON).
func readReviewFile(path string) *prReview {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("[harness] no review file at %s: %v", path, err)
		return nil
	}
	var r prReview
	if err := json.Unmarshal(data, &r); err != nil {
		log.Printf("[harness] warn: review file is not valid JSON: %v", err)
		return nil
	}
	return &r
}

// postReview marshals the review and POSTs it to the Bandolier review endpoint
// with the per-job auth headers. A non-2xx response is a failure so the run
// reflects that no review was posted.
func postReview(ctx context.Context, cfg config, review *prReview) error {
	payload, err := json.Marshal(review)
	if err != nil {
		return fmt.Errorf("marshal review: %w", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := bando.post(reqCtx, cfg.reviewURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("post review: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("review submit status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result struct {
		URL string `json:"url"`
	}
	if json.NewDecoder(resp.Body).Decode(&result) == nil && result.URL != "" {
		log.Printf("[harness] REVIEW_URL=%s", result.URL)
	} else {
		log.Printf("[harness] review submitted")
	}
	return nil
}

// generateReviewSummary asks the out-of-band writer model to summarise the
// reviewer agent's transcript into a review body, for the fallback when the
// agent didn't leave a usable review file. Returns "" on any failure.
func generateReviewSummary(ctx context.Context, cfg config, transcript string) string {
	_, body := generateWriterContent(ctx, cfg, buildReviewSummaryPrompt(transcript))
	return body
}

// buildReviewSummaryPrompt formats the writer prompt that turns the reviewer's
// transcript into a review body. Reuses the TITLE/BODY writer contract (the
// title is discarded) so it runs through the same generateWriterContent path as
// the PR- and issue-copy writers.
func buildReviewSummaryPrompt(transcript string) string {
	if len(transcript) > maxIssueTranscriptBytes {
		transcript = "…(transcript truncated)…\n" + transcript[len(transcript)-maxIssueTranscriptBytes:]
	}
	return fmt.Sprintf(`Write a GitHub pull request review based ONLY on the reviewer agent's transcript below — its analysis and conclusions. Be accurate and concrete; do not invent findings the transcript doesn't support.

Respond in EXACTLY this format, with no preamble and no code fences:
TITLE: <single-line summary, ~70 chars max>
BODY:
<markdown review: a one or two sentence summary, then the notable findings as a bullet list, referencing concrete files where the transcript does>

=== AGENT TRANSCRIPT ===
%s`, strings.TrimSpace(transcript))
}
