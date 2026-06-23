package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestSlugify(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Fix the login bug", "fix-the-login-bug"},
		{"Add   OAuth!! support", "add-oauth-support"},
		{"  !!hello!!  ", "hello"},
		{"UPPER case Title", "upper-case-title"},
		{"", "task"},
		{"!!!", "task"},
		// Truncated to <=24 chars with no trailing hyphen.
		{"this is a very long issue title that exceeds the limit", "this-is-a-very-long-issu"},
	}
	for _, c := range cases {
		if got := slugify(c.in); got != c.want {
			t.Errorf("slugify(%q) = %q, want %q", c.in, got, c.want)
		}
		if len(slugify(c.in)) > 24 {
			t.Errorf("slugify(%q) exceeds 24 chars", c.in)
		}
	}
}

func TestSlugifyNeverHasEdgeHyphens(t *testing.T) {
	// A title whose first 24 chars end mid-separator must not yield a trailing
	// hyphen after truncation.
	got := slugify("abcdefghijklmnopqrstuv!!extra")
	if strings.HasPrefix(got, "-") || strings.HasSuffix(got, "-") {
		t.Errorf("slugify produced edge hyphen: %q", got)
	}
}

func TestShortUnique(t *testing.T) {
	s := shortUnique()
	if len(s) != 6 {
		t.Errorf("shortUnique() = %q, want length 6", s)
	}
	if !regexp.MustCompile(`^[0-9a-z]{6}$`).MatchString(s) {
		t.Errorf("shortUnique() = %q, want base-36 chars", s)
	}
}

func TestIssueBranchName(t *testing.T) {
	got := issueBranchName(42, "Fix the login bug")
	re := regexp.MustCompile(`^issue-42-fix-the-login-bug-[0-9a-z]{6}$`)
	if !re.MatchString(got) {
		t.Errorf("issueBranchName = %q, want match %v", got, re)
	}
}

func TestRepoBranchName(t *testing.T) {
	got := repoBranchName("Add feature")
	re := regexp.MustCompile(`^bandolier/add-feature-[0-9a-z]{6}$`)
	if !re.MatchString(got) {
		t.Errorf("repoBranchName = %q, want match %v", got, re)
	}
}

func TestBuildRepoSystemPrompt(t *testing.T) {
	got := buildRepoSystemPrompt("bandolier/do-the-thing-abc123")
	if !strings.Contains(got, `on branch "bandolier/do-the-thing-abc123"`) {
		t.Error("buildRepoSystemPrompt should mention the branch")
	}
	if !strings.Contains(got, "git commit -s") {
		t.Error("buildRepoSystemPrompt should instruct a signed commit")
	}
	if !strings.Contains(got, "Do NOT push or open a pull request") {
		t.Error("buildRepoSystemPrompt should forbid pushing")
	}
}

func TestBuildIssueSystemPrompt(t *testing.T) {
	issue := &githubIssue{Number: 5, Title: "Crash on startup", Body: "It crashes."}
	got := buildIssueSystemPrompt(issue, "issue-5-crash")

	if !strings.Contains(got, `on branch "issue-5-crash"`) {
		t.Error("missing branch instruction")
	}
	if !strings.Contains(got, `git commit -s -m "Crash on startup"`) {
		t.Error("commit step should use the issue title as the subject")
	}
	if !strings.Contains(got, "Do NOT push or open a pull request") {
		t.Error("missing no-push instruction")
	}
	// The issue body belongs in the user message, not the system prompt.
	if strings.Contains(got, "It crashes.") {
		t.Error("system prompt should not embed the issue body")
	}
}

func TestBuildIssueUserMessage(t *testing.T) {
	issue := &githubIssue{Number: 5, Title: "Crash on startup", Body: "It crashes."}
	got := buildIssueUserMessage(issue, "")

	if !strings.Contains(got, "## Issue #5: Crash on startup") {
		t.Error("missing issue heading")
	}
	if !strings.Contains(got, "It crashes.") {
		t.Error("missing issue body")
	}
	// The instructional framing belongs in the system prompt, not the message.
	if strings.Contains(got, "Do NOT push") {
		t.Error("user message should not embed the working agreement")
	}
	if strings.Contains(got, "Additional context from the operator") {
		t.Error("should not include operator section when context is empty")
	}
}

func TestBuildIssueUserMessageEmptyBody(t *testing.T) {
	issue := &githubIssue{Number: 1, Title: "T", Body: "   "}
	got := buildIssueUserMessage(issue, "")
	if !strings.Contains(got, "(no description provided)") {
		t.Error("empty body should be replaced with placeholder")
	}
}

func TestBuildIssueUserMessageWithContext(t *testing.T) {
	issue := &githubIssue{Number: 1, Title: "T", Body: "B"}
	got := buildIssueUserMessage(issue, "  Focus on the parser.  ")
	if !strings.Contains(got, "## Additional context from the operator") {
		t.Error("should include operator section when context is provided")
	}
	if !strings.Contains(got, "Focus on the parser.") {
		t.Error("should include the operator context text")
	}
}

func TestBuildInteractiveSystemPrompt(t *testing.T) {
	got := buildInteractiveSystemPrompt("bandolier/chat-abc123")
	if !strings.Contains(got, "interactive session") {
		t.Error("should describe the interactive session")
	}
	if !strings.Contains(got, `on branch "bandolier/chat-abc123"`) {
		t.Error("should mention the working branch")
	}
	if buildInteractiveSystemPrompt("") != "" {
		t.Error("should be empty when there's no working branch")
	}
}

func TestParsePRContent(t *testing.T) {
	out := "TITLE: Add retry logic\nBODY:\nThis adds retries.\n\n## Changes\n- retry on 500"
	title, body := parsePRContent(out)
	if title != "Add retry logic" {
		t.Errorf("title = %q", title)
	}
	if !strings.HasPrefix(body, "This adds retries.") {
		t.Errorf("body = %q", body)
	}
	if !strings.Contains(body, "## Changes") {
		t.Errorf("body should retain markdown sections, got %q", body)
	}
}

func TestParsePRContentNoTitle(t *testing.T) {
	title, body := parsePRContent("just some text with no markers")
	if title != "" || body != "" {
		t.Errorf("expected empty title/body, got (%q, %q)", title, body)
	}
}

func TestParsePRContentTitleOnly(t *testing.T) {
	title, body := parsePRContent("TITLE: Only a title")
	if title != "Only a title" {
		t.Errorf("title = %q", title)
	}
	if body != "" {
		t.Errorf("body = %q, want empty", body)
	}
}

func TestEnsureCloses(t *testing.T) {
	t.Run("prepends closing keyword when absent", func(t *testing.T) {
		got := ensureCloses("Some description.", "42")
		if !strings.HasPrefix(got, "Closes #42") {
			t.Errorf("got %q", got)
		}
		if !strings.Contains(got, "Some description.") {
			t.Error("original body should be preserved")
		}
	})

	t.Run("is idempotent when closing keyword already present", func(t *testing.T) {
		body := "Closes #42\n\nDetails here."
		if got := ensureCloses(body, "42"); got != body {
			t.Errorf("ensureCloses changed an already-closing body: %q", got)
		}
	})

	t.Run("matches the keyword case-insensitively", func(t *testing.T) {
		body := "closes #42 in the description"
		if got := ensureCloses(body, "42"); got != body {
			t.Errorf("should treat lowercase 'closes' as present, got %q", got)
		}
	})

	t.Run("synthesizes a body when empty", func(t *testing.T) {
		got := ensureCloses("   ", "42")
		if !strings.Contains(got, "Closes #42") {
			t.Errorf("got %q", got)
		}
		if !strings.Contains(got, "Generated by Bandolier.") {
			t.Errorf("got %q", got)
		}
	})
}

func TestSetEnvIfMissing(t *testing.T) {
	t.Run("adds a key that is absent", func(t *testing.T) {
		env := setEnvIfMissing([]string{"FOO=1"}, "BAR", "2")
		if !containsEnv(env, "BAR=2") {
			t.Errorf("BAR not added: %v", env)
		}
	})

	t.Run("leaves an existing key untouched", func(t *testing.T) {
		env := setEnvIfMissing([]string{"BAR=original"}, "BAR", "new")
		if !containsEnv(env, "BAR=original") || containsEnv(env, "BAR=new") {
			t.Errorf("existing BAR should be preserved: %v", env)
		}
	})
}

func TestProjectIDFromCredentials(t *testing.T) {
	t.Run("reads project_id from a service-account key", func(t *testing.T) {
		got := projectIDFromCredentials(`{"type":"service_account","project_id":"my-proj"}`)
		if got != "my-proj" {
			t.Errorf("project_id = %q, want my-proj", got)
		}
	})

	t.Run("falls back to quota_project_id", func(t *testing.T) {
		got := projectIDFromCredentials(`{"quota_project_id":"quota-proj"}`)
		if got != "quota-proj" {
			t.Errorf("quota fallback = %q, want quota-proj", got)
		}
	})

	t.Run("prefers project_id over quota_project_id", func(t *testing.T) {
		got := projectIDFromCredentials(`{"project_id":"p","quota_project_id":"q"}`)
		if got != "p" {
			t.Errorf("= %q, want p", got)
		}
	})

	t.Run("returns empty for invalid JSON", func(t *testing.T) {
		if got := projectIDFromCredentials("not json"); got != "" {
			t.Errorf("invalid JSON = %q, want empty", got)
		}
	})

	t.Run("returns empty when neither field is present", func(t *testing.T) {
		if got := projectIDFromCredentials(`{"type":"service_account"}`); got != "" {
			t.Errorf("= %q, want empty", got)
		}
	})
}

func TestBuildEnvOpenAI(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-openai")
	// CODEX_API_KEY is absent in the pod, mirroring the real environment. (Setting
	// it to "" via t.Setenv would count as present and skip the mirror.)
	t.Setenv("CODEX_API_KEY", "placeholder")
	_ = os.Unsetenv("CODEX_API_KEY")
	env := buildEnv(providerOpenAI)
	if !containsEnv(env, "CODEX_API_KEY=sk-openai") {
		t.Errorf("buildEnv(openai) should mirror OPENAI_API_KEY to CODEX_API_KEY: %v", env)
	}
}

func TestCodexArgs(t *testing.T) {
	cfg := config{model: "gpt-5"}

	// One-shot: no resume, ephemeral session, model + json + prompt present.
	oneShot := codexArgs(cfg, "do the thing", false, true)
	if oneShot[0] != "exec" {
		t.Errorf("first arg = %q, want exec", oneShot[0])
	}
	joined := strings.Join(oneShot, " ")
	if !strings.Contains(joined, "--ephemeral") {
		t.Errorf("one-shot should be --ephemeral: %v", oneShot)
	}
	if strings.Contains(joined, "resume") {
		t.Errorf("one-shot should not resume: %v", oneShot)
	}
	if oneShot[len(oneShot)-1] != "do the thing" {
		t.Errorf("prompt should be the last arg: %v", oneShot)
	}
	if !strings.Contains(joined, "--model gpt-5") {
		t.Errorf("model flag missing: %v", oneShot)
	}

	// Resume turn: `exec resume --last`, persisted (no --ephemeral).
	resume := codexArgs(cfg, "next message", true, false)
	rjoined := strings.Join(resume, " ")
	if !strings.Contains(rjoined, "exec resume --last") {
		t.Errorf("resume should use `exec resume --last`: %v", resume)
	}
	if strings.Contains(rjoined, "--ephemeral") {
		t.Errorf("resume turn must persist (no --ephemeral): %v", resume)
	}
	if resume[len(resume)-1] != "next message" {
		t.Errorf("prompt should be the last arg: %v", resume)
	}
}

func TestFoldSystemPrompt(t *testing.T) {
	if got := foldSystemPrompt("", "just a task"); got != "just a task" {
		t.Errorf("no system prompt should pass the task through: %q", got)
	}
	got := foldSystemPrompt("FRAMING", "TASK")
	if !strings.HasPrefix(got, "FRAMING") || !strings.HasSuffix(got, "TASK") {
		t.Errorf("system prompt should be prepended to the task: %q", got)
	}
}

func TestBuildEnvGemini(t *testing.T) {
	// With no project credentials and no ANTIGRAVITY_API_KEY, a legacy
	// GEMINI_API_KEY is mirrored so agy still finds a credential.
	_ = os.Unsetenv("GOOGLE_PROJECT_CREDENTIALS")
	_ = os.Unsetenv("ANTIGRAVITY_API_KEY")
	t.Setenv("GEMINI_API_KEY", "AIza-gemini")
	env := buildEnv(providerGemini)
	if !containsEnv(env, "ANTIGRAVITY_API_KEY=AIza-gemini") {
		t.Errorf("buildEnv(gemini) should mirror GEMINI_API_KEY to ANTIGRAVITY_API_KEY: %v", env)
	}
}

func TestBuildEnvGeminiProjectCredentials(t *testing.T) {
	// With project credentials JSON injected, buildEnv writes it to
	// ~/.gemini/credentials.json and sets the ADC / Vertex / project env.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("GEMINI_API_KEY", "")
	t.Setenv("ANTIGRAVITY_API_KEY", "")
	t.Setenv("GOOGLE_PROJECT_CREDENTIALS", `{"type":"service_account","project_id":"my-proj"}`)

	env := buildEnv(providerGemini)

	credPath := filepath.Join(home, ".gemini", "credentials.json")
	if !containsEnv(env, "GOOGLE_APPLICATION_CREDENTIALS="+credPath) {
		t.Errorf("buildEnv(gemini) should point GOOGLE_APPLICATION_CREDENTIALS at the written file: %v", env)
	}
	if !containsEnv(env, "GOOGLE_GENAI_USE_VERTEXAI=true") {
		t.Errorf("buildEnv(gemini) should enable Vertex mode: %v", env)
	}
	if !containsEnv(env, "GOOGLE_CLOUD_PROJECT=my-proj") {
		t.Errorf("buildEnv(gemini) should derive GOOGLE_CLOUD_PROJECT from project_id: %v", env)
	}
	data, err := os.ReadFile(credPath)
	if err != nil {
		t.Fatalf("credentials file not written: %v", err)
	}
	if !strings.Contains(string(data), "my-proj") {
		t.Errorf("credentials file should contain the injected JSON, got: %s", data)
	}
}

func TestAgyArgs(t *testing.T) {
	args := agyArgs(config{model: "gemini-2.5-pro"}, "do the thing")
	joined := strings.Join(args, " ")
	// -p must be immediately followed by the prompt as its own argument (no shell).
	if len(args) < 2 || args[0] != "-p" || args[1] != "do the thing" {
		t.Errorf("agy args should pass the prompt as the -p value: %v", args)
	}
	if !strings.Contains(joined, "--model gemini-2.5-pro") {
		t.Errorf("agy args should set the model: %v", args)
	}
	if !strings.Contains(joined, "--dangerously-skip-permissions") {
		t.Errorf("agy args should auto-approve tool actions: %v", args)
	}
}

func TestHandleCodexEvent(t *testing.T) {
	// Redirect the assistant-text sink to a buffer for the duration of the test.
	var buf bytes.Buffer
	orig := stdoutTee
	stdoutTee = &buf
	defer func() { stdoutTee = orig }()

	// An agent_message item renders its text to stdout (assistant output).
	handleCodexEvent([]byte(`{"type":"item.completed","item":{"type":"agent_message","text":"Hello world"}}`))
	if got := strings.TrimSpace(buf.String()); got != "Hello world" {
		t.Errorf("agent_message text = %q, want %q", got, "Hello world")
	}

	// A command_execution item is not assistant text — nothing on stdout.
	buf.Reset()
	handleCodexEvent([]byte(`{"type":"item.completed","item":{"type":"command_execution","command":"ls -la"}}`))
	if buf.Len() != 0 {
		t.Errorf("command_execution should not write to stdout, got %q", buf.String())
	}

	// Invalid JSON is ignored without panicking or writing.
	buf.Reset()
	handleCodexEvent([]byte(`not json`))
	if buf.Len() != 0 {
		t.Errorf("invalid JSON should be ignored, got %q", buf.String())
	}
}

func TestLogUserInput(t *testing.T) {
	// logUserInput writes through the log package; capture that output and drop
	// the timestamp/flags so we assert only the tagged content.
	var buf bytes.Buffer
	origOut := log.Writer()
	origFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(origOut)
		log.SetFlags(origFlags)
	}()

	logUserInput("first line\nsecond line")

	got := buf.String()
	want := "[user] first line\n[user] second line\n"
	if got != want {
		t.Errorf("logUserInput output = %q, want %q", got, want)
	}
}

func TestRewriteCommitAuthors(t *testing.T) {
	dir := t.TempDir()

	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		// A clean, deterministic identity for the seed commits we then rewrite.
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Claude", "GIT_AUTHOR_EMAIL=noreply@anthropic.com",
			"GIT_COMMITTER_NAME=Claude", "GIT_COMMITTER_EMAIL=noreply@anthropic.com",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}

	// A bare "origin" the working repo treats as its remote, so origin/main
	// resolves the way the harness expects in the pod.
	remote := t.TempDir()
	cmdRun(t, remote, "git", "init", "--bare", "-b", "main")

	cmdRun(t, dir, "git", "init", "-b", "main")
	git("remote", "add", "origin", remote)
	// Base commit on main.
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-m", "base commit")
	git("push", "origin", "main")

	// Work branch with two commits: one carrying a Claude co-author trailer, one
	// authored entirely as Claude.
	git("checkout", "-b", "work")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-m", "first change\n\nCo-authored-by: Claude <noreply@anthropic.com>")
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-m", "second change")

	cfg := config{workDir: dir, baseBranch: "main"}
	if err := rewriteCommitAuthors(context.Background(), cfg, "work", "octocat", "1+octocat@users.noreply.github.com"); err != nil {
		t.Fatalf("rewriteCommitAuthors: %v", err)
	}

	// Both new commits must now be authored and committed by the OAuth identity.
	idents := git("log", "origin/main..work", "--pretty=format:%an|%ae|%cn|%ce")
	for _, line := range strings.Split(idents, "\n") {
		if line != "octocat|1+octocat@users.noreply.github.com|octocat|1+octocat@users.noreply.github.com" {
			t.Errorf("commit identity not rewritten: %q", line)
		}
	}

	// The Claude co-author trailer must be gone from every commit message.
	msgs := git("log", "origin/main..work", "--pretty=format:%B")
	if strings.Contains(strings.ToLower(msgs), "anthropic") || strings.Contains(strings.ToLower(msgs), "co-authored-by: claude") {
		t.Errorf("Claude co-author trailer survived rewrite:\n%s", msgs)
	}
	// The real commit subjects must survive.
	if !strings.Contains(msgs, "first change") || !strings.Contains(msgs, "second change") {
		t.Errorf("commit subjects lost in rewrite:\n%s", msgs)
	}
}

func TestRewriteCommitAuthorsNoCommits(t *testing.T) {
	dir := t.TempDir()
	remote := t.TempDir()
	cmdRun(t, remote, "git", "init", "--bare", "-b", "main")
	cmdRun(t, dir, "git", "init", "-b", "main")
	cmdRun(t, dir, "git", "-c", "user.name=x", "-c", "user.email=x@x",
		"remote", "add", "origin", remote)
	cmdRun(t, dir, "git", "-c", "user.name=x", "-c", "user.email=x@x",
		"commit", "--allow-empty", "-m", "base")
	cmdRun(t, dir, "git", "push", "origin", "main")

	// Branch with no commits over the base — a no-op, no error.
	cmdRun(t, dir, "git", "checkout", "-b", "work")
	cfg := config{workDir: dir, baseBranch: "main"}
	if err := rewriteCommitAuthors(context.Background(), cfg, "work", "octocat", "o@x"); err != nil {
		t.Fatalf("rewriteCommitAuthors on empty branch should be a no-op: %v", err)
	}
}

// cmdRun runs a command in dir, failing the test on error.
func cmdRun(t *testing.T, dir string, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
}

func containsEnv(env []string, want string) bool {
	for _, e := range env {
		if e == want {
			return true
		}
	}
	return false
}

func TestToolSummary(t *testing.T) {
	cases := []struct {
		name  string
		tool  string
		input string
		want  string
	}{
		{"bash command", "Bash", `{"command":"ls -la"}`, "Bash: ls -la"},
		{"file path", "Read", `{"file_path":"/tmp/x"}`, "Read: /tmp/x"},
		{"pattern in path", "Grep", `{"pattern":"foo","path":"src"}`, "Grep: foo in src"},
		{"path only", "LS", `{"path":"src"}`, "LS: src"},
		{"pattern only", "Glob", `{"pattern":"*.go"}`, "Glob: *.go"},
		{"url", "WebFetch", `{"url":"https://x.com"}`, "WebFetch: https://x.com"},
		{"query", "WebSearch", `{"query":"golang"}`, "WebSearch: golang"},
		{"empty input falls back to name", "Foo", `{}`, "Foo"},
		{"invalid json falls back to name", "Foo", `not json`, "Foo"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := toolSummary(c.tool, json.RawMessage(c.input))
			if got != c.want {
				t.Errorf("toolSummary(%q, %s) = %q, want %q", c.tool, c.input, got, c.want)
			}
		})
	}
}

func TestToolSummaryUnknownShape(t *testing.T) {
	// A tool input with only unrecognized keys serializes the full map.
	got := toolSummary("Custom", json.RawMessage(`{"foo":"bar"}`))
	if !strings.HasPrefix(got, "Custom: ") || !strings.Contains(got, "foo") {
		t.Errorf("unexpected fallback rendering: %q", got)
	}
}

func TestDetectProvider(t *testing.T) {
	// Clear all provider-selecting vars, then assert each selection path.
	for _, k := range []string{"CLAUDE_CODE_USE_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_PROJECT_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS", "ANTIGRAVITY_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"} {
		t.Setenv(k, "")
	}
	if got := detectProvider(); got != providerNone {
		t.Errorf("no env → %v, want providerNone", got)
	}

	t.Setenv("GOOGLE_PROJECT_CREDENTIALS", `{"project_id":"p"}`)
	if got := detectProvider(); got != providerGemini {
		t.Errorf("GOOGLE_PROJECT_CREDENTIALS set → %v, want providerGemini", got)
	}
	t.Setenv("GOOGLE_PROJECT_CREDENTIALS", "")

	t.Setenv("ANTIGRAVITY_API_KEY", "AIza-antigravity")
	if got := detectProvider(); got != providerGemini {
		t.Errorf("ANTIGRAVITY_API_KEY set → %v, want providerGemini", got)
	}

	t.Setenv("ANTIGRAVITY_API_KEY", "")
	t.Setenv("GEMINI_API_KEY", "AIza-gemini")
	if got := detectProvider(); got != providerGemini {
		t.Errorf("legacy GEMINI_API_KEY set → %v, want providerGemini", got)
	}

	t.Setenv("OPENAI_API_KEY", "sk-openai")
	if got := detectProvider(); got != providerOpenAI {
		t.Errorf("OPENAI_API_KEY beats Gemini → %v, want providerOpenAI", got)
	}

	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	if got := detectProvider(); got != providerBedrock {
		t.Errorf("USE_BEDROCK=1 → %v, want providerBedrock", got)
	}

	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-x")
	if got := detectProvider(); got != providerAnthropic {
		t.Errorf("ANTHROPIC_API_KEY beats OpenAI → %v, want providerAnthropic", got)
	}

	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	if got := detectProvider(); got != providerBedrock {
		t.Errorf("AWS keys take precedence → %v, want providerBedrock", got)
	}
}
