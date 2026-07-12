package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// covGHGit runs git in dir with a fixed, deterministic identity, returning the
// trimmed combined output and failing the test on any git error.
func covGHGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Tester", "GIT_AUTHOR_EMAIL=tester@example.com",
		"GIT_COMMITTER_NAME=Tester", "GIT_COMMITTER_EMAIL=tester@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// covGHRepoWithRemote builds a working repo whose origin/main ref resolves and
// a local "work" branch that adds feature.txt over main — the shape hasCommits
// and buildPRPrompt read (both diff against cfg.diffBase(), i.e. origin/main).
func covGHRepoWithRemote(t *testing.T) string {
	t.Helper()
	remote := t.TempDir()
	cmdRun(t, remote, "git", "init", "--bare", "-b", "main")

	dir := t.TempDir()
	covGHGit(t, dir, "init", "-b", "main")
	covGHGit(t, dir, "remote", "add", "origin", remote)
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	covGHGit(t, dir, "add", "-A")
	covGHGit(t, dir, "commit", "-m", "base commit")
	covGHGit(t, dir, "push", "origin", "main")

	covGHGit(t, dir, "checkout", "-b", "work")
	if err := os.WriteFile(filepath.Join(dir, "feature.txt"), []byte("hello feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	covGHGit(t, dir, "add", "-A")
	covGHGit(t, dir, "commit", "-m", "Add the feature file")
	return dir
}

// covGHFakeGh writes an executable `gh` shim running the given shell script and
// prepends its directory to PATH, so fetchIssue's exec.CommandContext("gh", …)
// resolves the shim instead of any real gh.
func covGHFakeGh(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestCovGHIssueOutputSystemPrompt(t *testing.T) {
	t.Run("no parent uses the generic analyse-the-task scope", func(t *testing.T) {
		got := buildIssueOutputSystemPrompt(nil)
		if !strings.Contains(got, "produces a GitHub issue, NOT code") {
			t.Errorf("should frame an issue-output run, got %q", got)
		}
		if !strings.Contains(got, "Analyse the task in the user message against the repository.") {
			t.Errorf("nil parent should use the generic scope, got %q", got)
		}
		if strings.Contains(got, "Break down parent issue") {
			t.Errorf("nil parent must not reference a parent, got %q", got)
		}
		if !strings.Contains(got, "Do NOT modify files") {
			t.Errorf("should forbid modifying files, got %q", got)
		}
	})

	t.Run("non-nil parent scopes a sub-task of #Number", func(t *testing.T) {
		got := buildIssueOutputSystemPrompt(&githubIssue{Number: 7, Title: "Parent"})
		if !strings.Contains(got, "Break down parent issue #7") {
			t.Errorf("should reference the parent by number, got %q", got)
		}
		if !strings.Contains(got, "sub-task") {
			t.Errorf("should scope the issue as a sub-task, got %q", got)
		}
		if strings.Contains(got, "Analyse the task in the user message against the repository.") {
			t.Errorf("parent case must not use the generic scope, got %q", got)
		}
	})
}

func TestCovGHIssueOutputInteractivePrompt(t *testing.T) {
	got := buildIssueOutputInteractivePrompt()
	for _, want := range []string{
		"interactive session",
		"produces a GitHub issue, NOT code",
		"read-only",
		"do not modify files",
		"follow-up",
		"opens a GitHub issue",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("issue-output interactive prompt missing %q, got %q", want, got)
		}
	}
}

func TestCovGHInteractiveFraming(t *testing.T) {
	t.Run("issueOutput true returns the issue-output interactive prompt", func(t *testing.T) {
		// The branch is irrelevant in issue-output mode.
		got := interactiveFraming(true, "bandolier/ignored-branch")
		if got != buildIssueOutputInteractivePrompt() {
			t.Errorf("issueOutput=true framing = %q, want the issue-output interactive prompt", got)
		}
	})

	t.Run("issueOutput false with a branch returns the commit-as-you-go framing", func(t *testing.T) {
		got := interactiveFraming(false, "bandolier/chat-abc123")
		if got != buildInteractiveSystemPrompt("bandolier/chat-abc123") {
			t.Errorf("issueOutput=false framing = %q, want buildInteractiveSystemPrompt(branch)", got)
		}
		if !strings.Contains(got, `on branch "bandolier/chat-abc123"`) {
			t.Errorf("branch framing should mention the working branch, got %q", got)
		}
	})

	t.Run("issueOutput false with an empty branch returns empty", func(t *testing.T) {
		if got := interactiveFraming(false, ""); got != "" {
			t.Errorf("empty-branch framing = %q, want \"\"", got)
		}
	})
}

func TestCovGHInstallSignoffHook(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	hooksDir, err := installSignoffHook()
	if err != nil {
		t.Fatalf("installSignoffHook: %v", err)
	}
	if want := filepath.Join(os.TempDir(), "bandolier-githooks"); hooksDir != want {
		t.Errorf("hooksDir = %q, want %q", hooksDir, want)
	}

	path := filepath.Join(hooksDir, "prepare-commit-msg")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat prepare-commit-msg: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("prepare-commit-msg is not executable: mode %v", info.Mode().Perm())
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read hook: %v", err)
	}
	hook := string(body)
	if !strings.Contains(hook, "Signed-off-by:") {
		t.Errorf("hook should add a Signed-off-by trailer, got:\n%s", hook)
	}
	if !strings.Contains(hook, "git interpret-trailers") || !strings.Contains(hook, "--in-place") {
		t.Errorf("hook should append the trailer in place via interpret-trailers, got:\n%s", hook)
	}
}

func TestCovGHLatestCommitSubject(t *testing.T) {
	dir := t.TempDir()
	covGHGit(t, dir, "init", "-b", "main")
	covGHGit(t, dir, "commit", "--allow-empty", "-m", "First subject line")
	covGHGit(t, dir, "commit", "--allow-empty", "-m", "Second subject line")

	cfg := config{workDir: dir}
	if got := latestCommitSubject(context.Background(), cfg, "main"); got != "Second subject line" {
		t.Errorf("latestCommitSubject = %q, want the most recent subject", got)
	}

	// A branch that doesn't exist makes git fail, and the subject is empty.
	if got := latestCommitSubject(context.Background(), cfg, "no-such-branch"); got != "" {
		t.Errorf("latestCommitSubject(nonexistent branch) = %q, want \"\"", got)
	}
}

func TestCovGHHasCommits(t *testing.T) {
	dir := covGHRepoWithRemote(t)

	t.Run("branch with commits over the base reports true", func(t *testing.T) {
		cfg := config{workDir: dir, baseBranch: "main"}
		if !hasCommits(context.Background(), cfg, "work") {
			t.Error("hasCommits = false for a branch that adds a commit, want true")
		}
	})

	t.Run("branch even with the base reports false", func(t *testing.T) {
		cfg := config{workDir: dir, baseBranch: "main"}
		// Local main sits exactly at origin/main, so origin/main..main is empty.
		if hasCommits(context.Background(), cfg, "main") {
			t.Error("hasCommits = true for a branch with no commits over the base, want false")
		}
	})

	t.Run("unresolvable diff base makes git fail and assumes there is something to push", func(t *testing.T) {
		// origin/does-not-exist never resolves, so git rev-list errors and
		// hasCommits falls back to true ("if we can't tell, assume").
		cfg := config{workDir: dir, baseBranch: "does-not-exist"}
		if !hasCommits(context.Background(), cfg, "also-missing") {
			t.Error("hasCommits = false when git fails, want true (assume something to push)")
		}
	})
}

func TestCovGHFetchIssue(t *testing.T) {
	t.Run("parses the gh JSON into a githubIssue", func(t *testing.T) {
		covGHFakeGh(t, "#!/bin/sh\n"+
			`echo '{"number":42,"title":"Fix the flaky test","body":"It fails intermittently."}'`+"\n")

		issue, err := fetchIssue(context.Background(), t.TempDir(), "42")
		if err != nil {
			t.Fatalf("fetchIssue: %v", err)
		}
		if issue.Number != 42 {
			t.Errorf("Number = %d, want 42", issue.Number)
		}
		if issue.Title != "Fix the flaky test" {
			t.Errorf("Title = %q, want %q", issue.Title, "Fix the flaky test")
		}
		if issue.Body != "It fails intermittently." {
			t.Errorf("Body = %q, want %q", issue.Body, "It fails intermittently.")
		}
	})

	t.Run("a non-zero gh exit is surfaced as an error", func(t *testing.T) {
		covGHFakeGh(t, "#!/bin/sh\necho 'gh: not authenticated' >&2\nexit 1\n")

		issue, err := fetchIssue(context.Background(), t.TempDir(), "42")
		if err == nil {
			t.Fatal("fetchIssue should return an error when gh exits non-zero")
		}
		if issue != nil {
			t.Errorf("issue = %+v, want nil on error", issue)
		}
	})
}

func TestCovGHBuildPRPrompt(t *testing.T) {
	dir := covGHRepoWithRemote(t)
	cfg := config{workDir: dir, baseBranch: "main"}

	got := buildPRPrompt(context.Background(), cfg, "work")

	// The prompt frames the TITLE/BODY contract and carries the three context
	// blocks assembled from git log/diff.
	for _, want := range []string{
		"TITLE:",
		"=== COMMITS ===",
		"=== DIFFSTAT ===",
		"=== DIFF ===",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("PR prompt missing %q section, got:\n%s", want, got)
		}
	}
	// The single commit this branch adds appears in the COMMITS block.
	if !strings.Contains(got, "Add the feature file") {
		t.Errorf("PR prompt should include the commit subject, got:\n%s", got)
	}
	// The added file shows up in the diff/diffstat computed over origin/main.
	if !strings.Contains(got, "feature.txt") {
		t.Errorf("PR prompt should include the changed file, got:\n%s", got)
	}
}

func TestSummarizeNumstat(t *testing.T) {
	// Two text files plus a binary file, which reports "-" for its line counts.
	got := summarizeNumstat("10\t2\tsrc/a.go\n5\t0\tsrc/b.go\n-\t-\tassets/logo.png\n")
	if got.files != 3 {
		t.Errorf("files = %d, want 3", got.files)
	}
	if got.added != 15 {
		t.Errorf("added = %d, want 15", got.added)
	}
	if got.deleted != 2 {
		t.Errorf("deleted = %d, want 2", got.deleted)
	}
	if got.lines() != 17 {
		t.Errorf("lines = %d, want 17", got.lines())
	}
	if got.large() {
		t.Error("a 3-file, 17-line change should not count as large")
	}
	if empty := summarizeNumstat(""); empty.files != 0 || empty.lines() != 0 {
		t.Errorf("empty numstat = %+v, want a zero summary", empty)
	}
}

func TestDiffSummaryLarge(t *testing.T) {
	if !(diffSummary{files: largeDiffFiles}).large() {
		t.Error("hitting the file threshold should be large")
	}
	if !(diffSummary{added: largeDiffLines}).large() {
		t.Error("hitting the line threshold should be large")
	}
	if (diffSummary{files: largeDiffFiles - 1, added: largeDiffLines - 1}).large() {
		t.Error("just under both thresholds should not be large")
	}
}

func TestRenderPRPromptReviewOrder(t *testing.T) {
	// A small change keeps the plain format contract and no review-order ask.
	small := renderPRPrompt("- did a thing", "a | 1 +", "diff body", diffSummary{files: 1, added: 1})
	for _, want := range []string{"TITLE:", "BODY:", "=== COMMITS ===", "=== DIFFSTAT ===", "=== DIFF ==="} {
		if !strings.Contains(small, want) {
			t.Errorf("PR prompt missing %q section", want)
		}
	}
	if strings.Contains(small, "Suggested review order") {
		t.Errorf("small change should not request a review order, got:\n%s", small)
	}

	// A large change asks the writer to lead the body with a review-order walkthrough.
	large := renderPRPrompt("- did a thing", "stat", "diff body", diffSummary{files: largeDiffFiles, added: 500})
	if !strings.Contains(large, "Suggested review order") {
		t.Errorf("large change should request a review order, got:\n%s", large)
	}
	if !strings.Contains(large, "files changed") {
		t.Errorf("large-change guidance should state the size, got:\n%s", large)
	}
}
