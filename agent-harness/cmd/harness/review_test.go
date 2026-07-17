package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewOutput(t *testing.T) {
	if !(config{outputType: "review"}).reviewOutput() {
		t.Error("reviewOutput() = false for outputType=review, want true")
	}
	for _, ot := range []string{"pr", "issue", "", "Review", "reviews"} {
		if (config{outputType: ot}).reviewOutput() {
			t.Errorf("reviewOutput() = true for outputType=%q, want false", ot)
		}
	}
}

func TestLoadConfigReviewMode(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("CLAUDE_TASK", "Pull request #7: Add a feature")
	t.Setenv("OUTPUT_TYPE", "review")
	t.Setenv("REVIEW_PR_NUMBER", "7")
	t.Setenv("BANDOLIER_REVIEW_URL", "http://bando.local/api/agent-runs/review")

	c, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig() in review mode = %v, want nil", err)
	}
	if !c.reviewOutput() {
		t.Error("reviewOutput() = false, want true")
	}
	if c.reviewPRNumber != "7" {
		t.Errorf("reviewPRNumber = %q, want 7", c.reviewPRNumber)
	}
	if c.reviewURL != "http://bando.local/api/agent-runs/review" {
		t.Errorf("reviewURL = %q, want the submit endpoint", c.reviewURL)
	}
	// A review file path is set (workspace-external) so the agent has somewhere
	// to write, and it's absent for non-review runs.
	if c.reviewFile == "" {
		t.Error("reviewFile = empty in review mode, want a path")
	}
	clearConfigEnv(t)
	t.Setenv("CLAUDE_TASK", "do a thing")
	if c, _ := loadConfig(); c.reviewFile != "" {
		t.Errorf("reviewFile = %q for a non-review run, want empty", c.reviewFile)
	}
}

func TestReviewNormalize(t *testing.T) {
	// summary is accepted as an alias for body.
	r := &prReview{Summary: "looks good", Event: "COMMENT"}
	r.normalize()
	if r.Body != "looks good" {
		t.Errorf("Body = %q, want the summary aliased in", r.Body)
	}
	if r.Summary != "" {
		t.Errorf("Summary = %q, want cleared after coalescing", r.Summary)
	}
	// An unknown/empty event defaults to the non-blocking COMMENT.
	for _, ev := range []string{"", "comment", "LGTM"} {
		r := &prReview{Body: "b", Event: ev}
		r.normalize()
		if r.Event != "COMMENT" {
			t.Errorf("normalize() event for %q = %q, want COMMENT", ev, r.Event)
		}
	}
	// A valid event is preserved.
	r = &prReview{Body: "b", Event: "REQUEST_CHANGES"}
	r.normalize()
	if r.Event != "REQUEST_CHANGES" {
		t.Errorf("normalize() dropped a valid event: %q", r.Event)
	}
}

func TestReviewEmpty(t *testing.T) {
	if !(&prReview{}).empty() {
		t.Error("empty() = false for a blank review, want true")
	}
	if (&prReview{Body: "x"}).empty() {
		t.Error("empty() = true with a body, want false")
	}
	if (&prReview{Comments: []reviewComment{{Path: "a", Line: 1, Body: "c"}}}).empty() {
		t.Error("empty() = true with comments, want false")
	}
}

func TestReadReviewFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "review.json")
	if err := os.WriteFile(path, []byte(`{"event":"COMMENT","body":"ok","comments":[{"path":"a.ts","line":3,"body":"nit"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	r := readReviewFile(path)
	if r == nil || r.Body != "ok" || len(r.Comments) != 1 || r.Comments[0].Line != 3 {
		t.Errorf("readReviewFile() = %+v, want the parsed review", r)
	}
	// Missing / invalid files return nil rather than erroring.
	if readReviewFile(filepath.Join(dir, "nope.json")) != nil {
		t.Error("readReviewFile() on a missing file = non-nil, want nil")
	}
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte("not json"), 0o644)
	if readReviewFile(bad) != nil {
		t.Error("readReviewFile() on invalid JSON = non-nil, want nil")
	}
	if readReviewFile("") != nil {
		t.Error("readReviewFile(\"\") = non-nil, want nil")
	}
}

func TestBuildReviewOutputSystemPrompt(t *testing.T) {
	got := buildReviewOutputSystemPrompt("42", "/tmp/bandolier-review.json")
	for _, want := range []string{
		"pull request #42",
		"gh pr diff 42",
		"/tmp/bandolier-review.json",
		"Do NOT modify files",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("review system prompt missing %q", want)
		}
	}
}
