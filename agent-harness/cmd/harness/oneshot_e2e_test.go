package main

// Real-binary end-to-end test for the one-shot repo run: the compiled harness
// driven through its whole PR lifecycle against a genuine local git origin, a
// fake claude that actually commits, a fake gh that records its invocation, and
// the fakeBandolier ingest callback. The unit tests cover each step in isolation
// (rewriteCommitAuthors, openPR classification, uploadTranscript headers); this
// asserts they compose correctly when the real `harness` binary orchestrates a
// clone → branch → agent → rewrite → push → PR → ingest sequence.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// oneShotClaudeSrc is a fake claude for the one-shot path: it is invoked with the
// task as an argv (not stdin), makes a real file change and commits it authored
// as Claude — with a Claude co-author trailer the harness must strip — then emits
// the stream-json the harness renders: one assistant text event and a terminal
// result carrying token usage. git's own chatter is routed to stderr so it never
// pollutes stdout, which is the stream-json channel.
const oneShotClaudeSrc = `package main

import (
	"os"
	"os/exec"
)

func git(args ...string) {
	c := exec.Command("git", args...)
	c.Stdout = os.Stderr
	c.Stderr = os.Stderr
	c.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Claude",
		"GIT_AUTHOR_EMAIL=noreply@anthropic.com",
		"GIT_COMMITTER_NAME=Claude",
		"GIT_COMMITTER_EMAIL=noreply@anthropic.com",
	)
	if err := c.Run(); err != nil {
		os.Stderr.WriteString("fake-claude: git " + args[0] + " failed: " + err.Error() + "\n")
		os.Exit(3)
	}
}

func main() {
	if err := os.WriteFile("FEATURE.md", []byte("the login feature\n"), 0o644); err != nil {
		os.Stderr.WriteString("fake-claude: write: " + err.Error() + "\n")
		os.Exit(3)
	}
	git("add", "-A")
	git("commit", "-m", "Implement the login feature\n\nCo-authored-by: Claude <noreply@anthropic.com>")

	os.Stdout.WriteString("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"I implemented the login feature and committed it.\"}]}}\n")
	os.Stdout.WriteString("{\"type\":\"result\",\"num_turns\":1,\"usage\":{\"input_tokens\":11,\"output_tokens\":5,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}\n")
}
`

// fakeGhSrc is a fake gh CLI: it records its argv to GH_RECORD_FILE (so the test
// can assert `gh pr create` was invoked with the right branch/base) and prints a
// PR URL to stdout, which openPR scrapes as the created PR.
const fakeGhSrc = `package main

import (
	"os"
	"strings"
)

func main() {
	if rec := os.Getenv("GH_RECORD_FILE"); rec != "" {
		_ = os.WriteFile(rec, []byte(strings.Join(os.Args[1:], "\n")), 0o644)
	}
	os.Stdout.WriteString("https://github.com/octo/repo/pull/7\n")
}
`

// buildToolTo compiles src to <dir>/<name>.
func buildToolTo(t *testing.T, dir, name, src string) {
	t.Helper()
	srcFile := filepath.Join(t.TempDir(), name+".go")
	if err := os.WriteFile(srcFile, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, name)
	if out, err := exec.Command("go", "build", "-o", bin, srcFile).CombinedOutput(); err != nil {
		t.Fatalf("build fake %s: %v\n%s", name, err, out)
	}
}

// seedBareOrigin creates a bare origin with a `main` branch carrying one commit,
// returning the bare repo's path for use as REPO_URL.
func seedBareOrigin(t *testing.T) string {
	t.Helper()
	bare := t.TempDir()
	seed := t.TempDir()
	cmdRun(t, bare, "git", "init", "--bare", "-b", "main")
	cmdRun(t, seed, "git", "init", "-b", "main")
	cmdRun(t, seed, "git", "remote", "add", "origin", bare)
	cmdRun(t, seed, "git", "-c", "user.name=Seed", "-c", "user.email=seed@x",
		"commit", "--allow-empty", "-m", "initial commit")
	cmdRun(t, seed, "git", "push", "origin", "main")
	return bare
}

// TestOneShotRunLifecycle drives the compiled harness binary through a full
// one-shot repo run and asserts the whole PR pipeline: a commit was made,
// Claude's co-author trailer was stripped and authorship rewritten to the OAuth
// identity, the branch was pushed to the origin, the PR was opened via gh, the
// run emitted the PR_URL / BANDOLIER_TOKENS markers, and the ingest callback
// received the transcript with the Succeeded status and PR-URL headers.
func TestOneShotRunLifecycle(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping one-shot binary e2e in -short mode")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain unavailable")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}

	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}

	// Build the real harness binary and the two fakes it will invoke.
	buildDir := t.TempDir()
	harnessBin := filepath.Join(buildDir, "harness")
	if out, err := exec.Command("go", "build", "-o", harnessBin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build harness: %v\n%s", err, out)
	}
	toolDir := t.TempDir()
	buildToolTo(t, toolDir, "claude", oneShotClaudeSrc)
	buildToolTo(t, toolDir, "gh", fakeGhSrc)

	bareOrigin := seedBareOrigin(t)
	workDir := t.TempDir()
	homeDir := t.TempDir()
	ghRecord := filepath.Join(t.TempDir(), "gh-args.txt")

	// The ingest callback the harness posts its transcript + structured output to.
	f := newFakeBandolier(t)

	// A curated environment: start from the process env (for PATH's system dirs
	// so real git resolves) and override every key the run reads, forcing the
	// Anthropic path and isolating git's global config into a temp HOME so the
	// harness's `git config --global` never touches the developer's ~/.gitconfig.
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	env["PATH"] = toolDir + string(os.PathListSeparator) + env["PATH"]
	env["HOME"] = homeDir
	env["GIT_CONFIG_GLOBAL"] = filepath.Join(homeDir, ".gitconfig")
	env["GIT_CONFIG_SYSTEM"] = os.DevNull
	env["CLAUDE_TASK"] = "Implement the login feature"
	env["WORKING_DIR"] = workDir
	env["REPO_URL"] = bareOrigin
	env["AGENT_TITLE"] = "add login"
	env["GIT_NAME"] = "Octo Cat"
	env["GIT_EMAIL"] = "octo@users.noreply.github.com"
	env["SERENA_DISABLED"] = "1"
	env["ANTHROPIC_API_KEY"] = "test-key"
	// Clear anything that would flip provider detection off the Anthropic path.
	env["CLAUDE_CODE_USE_BEDROCK"] = ""
	env["AWS_ACCESS_KEY_ID"] = ""
	env["AWS_SECRET_ACCESS_KEY"] = ""
	env["OPENAI_API_KEY"] = ""
	env["BANDOLIER_LLM_PROVIDER"] = ""
	env["CLAUDE_CODE_OAUTH_TOKEN"] = ""
	env["BANDOLIER_INGEST_URL"] = f.srv.URL + "/ingest"
	env["BANDOLIER_INGEST_TOKEN"] = "tok-c"
	env["BANDOLIER_JOB"] = "job-c"
	env["GH_RECORD_FILE"] = ghRecord

	envSlice := make([]string, 0, len(env))
	for k, v := range env {
		envSlice = append(envSlice, k+"="+v)
	}

	cmd := exec.Command(harnessBin)
	cmd.Dir = wd
	cmd.Env = envSlice
	out, runErr := cmd.CombinedOutput()
	if runErr != nil {
		t.Fatalf("harness run failed: %v\n%s", runErr, out)
	}
	output := string(out)

	// The run emitted the structured-output markers on its log.
	if !strings.Contains(output, "PR_URL=https://github.com/octo/repo/pull/7") {
		t.Errorf("run did not emit the PR_URL marker\n%s", output)
	}
	if !strings.Contains(output, "BANDOLIER_TOKENS=") {
		t.Errorf("run did not emit the token marker\n%s", output)
	}

	// The PR was opened via gh with the pushed branch and the base branch.
	rec, err := os.ReadFile(ghRecord)
	if err != nil {
		t.Fatalf("gh was never invoked (no record file): %v", err)
	}
	ghArgs := string(rec)
	for _, want := range []string{"pr", "create", "--base", "main", "--head"} {
		if !strings.Contains(ghArgs, want) {
			t.Errorf("gh pr create args missing %q; got:\n%s", want, ghArgs)
		}
	}

	// The branch was pushed to the origin: find the bandolier/ ref the run created.
	branches, err := exec.Command("git", "-C", bareOrigin, "for-each-ref", "--format=%(refname:short)", "refs/heads/").Output()
	if err != nil {
		t.Fatalf("list origin branches: %v", err)
	}
	var pushed string
	for _, b := range strings.Fields(string(branches)) {
		if strings.HasPrefix(b, "bandolier/") {
			pushed = b
			break
		}
	}
	if pushed == "" {
		t.Fatalf("no bandolier/ branch was pushed to the origin; origin has:\n%s", branches)
	}
	if !strings.Contains(ghArgs, pushed) {
		t.Errorf("gh --head did not name the pushed branch %q; got:\n%s", pushed, ghArgs)
	}

	// A commit was made on the pushed branch beyond main.
	count, err := exec.Command("git", "-C", bareOrigin, "rev-list", "--count", "main.."+pushed).Output()
	if err != nil {
		t.Fatalf("rev-list on origin: %v", err)
	}
	if strings.TrimSpace(string(count)) != "1" {
		t.Errorf("pushed branch has %s new commits, want 1", strings.TrimSpace(string(count)))
	}

	// Authorship was rewritten to the OAuth identity and the Claude co-author
	// trailer stripped: the pushed commit is authored by Octo Cat with no
	// Claude/Anthropic attribution surviving anywhere in it.
	show, err := exec.Command("git", "-C", bareOrigin, "log", "-1", "--format=%an|%ae|%B", pushed).Output()
	if err != nil {
		t.Fatalf("log on origin: %v", err)
	}
	commit := string(show)
	if !strings.HasPrefix(commit, "Octo Cat|octo@users.noreply.github.com|") {
		t.Errorf("commit authorship not rewritten to the OAuth identity; got head:\n%s", commit)
	}
	if strings.Contains(strings.ToLower(commit), "anthropic") ||
		strings.Contains(strings.ToLower(commit), "co-authored-by: claude") {
		t.Errorf("Claude co-author trailer survived the rewrite:\n%s", commit)
	}
	if !strings.Contains(commit, "Implement the login feature") {
		t.Errorf("real commit subject lost in the rewrite:\n%s", commit)
	}

	// The ingest callback received the transcript body plus the contract headers.
	req := f.lastRequest(t, "POST", "/ingest")
	if got := req.headers.Get("Authorization"); got != "Bearer tok-c" {
		t.Errorf("ingest Authorization = %q, want %q", got, "Bearer tok-c")
	}
	if got := req.headers.Get("X-Bandolier-Job"); got != "job-c" {
		t.Errorf("ingest X-Bandolier-Job = %q, want %q", got, "job-c")
	}
	if got := req.headers.Get("X-Bandolier-Status"); got != "Succeeded" {
		t.Errorf("ingest X-Bandolier-Status = %q, want Succeeded", got)
	}
	if got := req.headers.Get("X-Bandolier-PR-URL"); got != "https://github.com/octo/repo/pull/7" {
		t.Errorf("ingest X-Bandolier-PR-URL = %q", got)
	}
	body := string(req.body)
	if !strings.Contains(body, "I implemented the login feature and committed it.") {
		t.Errorf("ingest body missing the assistant transcript text:\n%s", body)
	}
	if !strings.Contains(body, "BANDOLIER_TOKENS=") {
		t.Errorf("ingest body missing the token marker:\n%s", body)
	}
}
