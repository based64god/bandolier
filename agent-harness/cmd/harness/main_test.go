package main

import (
	"encoding/json"
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

func TestBuildRepoTask(t *testing.T) {
	got := buildRepoTask("  Do the thing  ", "bandolier/do-the-thing-abc123")
	if !strings.HasPrefix(got, "Do the thing") {
		t.Errorf("buildRepoTask should start with trimmed task, got:\n%s", got)
	}
	if !strings.Contains(got, `on branch "bandolier/do-the-thing-abc123"`) {
		t.Error("buildRepoTask should mention the branch")
	}
	if !strings.Contains(got, "git commit -s") {
		t.Error("buildRepoTask should instruct a signed commit")
	}
	if !strings.Contains(got, "Do NOT push or open a pull request") {
		t.Error("buildRepoTask should forbid pushing")
	}
}

func TestBuildIssueTask(t *testing.T) {
	issue := &githubIssue{Number: 5, Title: "Crash on startup", Body: "It crashes."}
	got := buildIssueTask(issue, "issue-5-crash", "")

	if !strings.Contains(got, "GitHub issue #5") {
		t.Error("missing issue number reference")
	}
	if !strings.Contains(got, "## Issue #5: Crash on startup") {
		t.Error("missing issue heading")
	}
	if !strings.Contains(got, "It crashes.") {
		t.Error("missing issue body")
	}
	if !strings.Contains(got, `on branch "issue-5-crash"`) {
		t.Error("missing branch instruction")
	}
	if strings.Contains(got, "Additional context from the operator") {
		t.Error("should not include operator section when context is empty")
	}
}

func TestBuildIssueTaskEmptyBody(t *testing.T) {
	issue := &githubIssue{Number: 1, Title: "T", Body: "   "}
	got := buildIssueTask(issue, "br", "")
	if !strings.Contains(got, "(no description provided)") {
		t.Error("empty body should be replaced with placeholder")
	}
}

func TestBuildIssueTaskWithContext(t *testing.T) {
	issue := &githubIssue{Number: 1, Title: "T", Body: "B"}
	got := buildIssueTask(issue, "br", "  Focus on the parser.  ")
	if !strings.Contains(got, "## Additional context from the operator") {
		t.Error("should include operator section when context is provided")
	}
	if !strings.Contains(got, "Focus on the parser.") {
		t.Error("should include the operator context text")
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

func TestIsResultEvent(t *testing.T) {
	if !isResultEvent([]byte(`{"type":"result","num_turns":3}`)) {
		t.Error("expected result event to be detected")
	}
	if isResultEvent([]byte(`{"type":"assistant"}`)) {
		t.Error("non-result event should not be detected")
	}
	if isResultEvent([]byte(`not json`)) {
		t.Error("invalid JSON should not be detected as a result event")
	}
}

func TestDetectProvider(t *testing.T) {
	// Clear all provider-selecting vars, then assert each selection path.
	for _, k := range []string{"CLAUDE_CODE_USE_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY"} {
		t.Setenv(k, "")
	}
	if got := detectProvider(); got != providerNone {
		t.Errorf("no env → %v, want providerNone", got)
	}

	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	if got := detectProvider(); got != providerBedrock {
		t.Errorf("USE_BEDROCK=1 → %v, want providerBedrock", got)
	}

	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-x")
	if got := detectProvider(); got != providerAnthropic {
		t.Errorf("ANTHROPIC_API_KEY set → %v, want providerAnthropic", got)
	}

	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	if got := detectProvider(); got != providerBedrock {
		t.Errorf("AWS keys take precedence → %v, want providerBedrock", got)
	}
}
