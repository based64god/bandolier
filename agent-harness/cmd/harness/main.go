// harness bootstraps a Claude Code agent inside a Kubernetes pod.
// It reads task configuration from environment variables, optionally clones
// a git repository, then runs `claude --print` non-interactively and exits
// with the same exit code so the Job's success/failure is recorded correctly.
//
// When GITHUB_ISSUE_NUMBER is set the harness enters "issue mode":
//   - It fetches the issue via `gh issue view` to build a structured task prompt
//   - It creates a dedicated git branch (issue-N/title-slug)
//   - After Claude finishes it pushes the branch and opens a PR that closes the issue
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
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

// uploadTranscript best-effort POSTs the captured transcript to Bandolier so it
// outlives the Job's TTL. No-op when the ingest env isn't injected.
func uploadTranscript() {
	url := os.Getenv("BANDOLIER_INGEST_URL")
	token := os.Getenv("BANDOLIER_INGEST_TOKEN")
	job := os.Getenv("BANDOLIER_JOB")
	if url == "" || token == "" || job == "" {
		return
	}

	body := []byte(transcript.String())
	// Use a fresh context: the run's context may already be canceled (SIGTERM).
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("[harness] warn: transcript request: %v", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Bandolier-Job", job)
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")

	resp, err := http.DefaultClient.Do(req)
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

// ── Provider detection ────────────────────────────────────────────────────────

type providerKind int

const (
	providerNone      providerKind = iota
	providerAnthropic              // direct Anthropic API
	providerBedrock                // AWS Bedrock
)

func detectProvider() providerKind {
	if os.Getenv("CLAUDE_CODE_USE_BEDROCK") == "1" {
		return providerBedrock
	}
	if os.Getenv("AWS_ACCESS_KEY_ID") != "" && os.Getenv("AWS_SECRET_ACCESS_KEY") != "" {
		return providerBedrock
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" {
		return providerAnthropic
	}
	return providerNone
}

// ── Config ────────────────────────────────────────────────────────────────────

type config struct {
	task         string
	systemPrompt string // instructional framing appended to Claude's system prompt
	title        string // short label used for branch slug, PR title, commit message
	workDir      string
	model        string
	prWriter     string // out-of-band model for writing the PR title/description
	repoURL      string
	branch       string
	maxTurns     string
	gitName      string
	gitEmail     string
	provider     providerKind
	issueNumber  string // GitHub issue number (issue mode)
	issueRepo    string // "owner/repo" for gh commands
	agentBranch  string // server-provided unique working branch (issue mode)
	baseBranch   string // base branch for the PR
	interactive  bool   // long-lived session driven by user input between turns
	inputURL     string // Bandolier endpoint the interactive loop polls for input
}

func loadConfig() (config, error) {
	issueNumber := os.Getenv("GITHUB_ISSUE_NUMBER")

	task := strings.TrimSpace(os.Getenv("CLAUDE_TASK"))
	if task == "" && issueNumber == "" {
		return config{}, fmt.Errorf("CLAUDE_TASK is required when GITHUB_ISSUE_NUMBER is not set")
	}

	workDir := os.Getenv("WORKING_DIR")
	if workDir == "" {
		workDir = "/workspace"
	}

	model := os.Getenv("CLAUDE_MODEL")
	if model == "" {
		model = "claude-sonnet-4-6"
	}

	// Always cap turns; default if the Job didn't set MAX_TURNS.
	maxTurns := os.Getenv("MAX_TURNS")
	if maxTurns == "" {
		maxTurns = "100"
	}

	baseBranch := os.Getenv("GITHUB_BASE_BRANCH")
	if baseBranch == "" {
		baseBranch = os.Getenv("BRANCH")
	}
	if baseBranch == "" {
		baseBranch = "main"
	}

	return config{
		task:         task,
		systemPrompt: strings.TrimSpace(os.Getenv("CLAUDE_SYSTEM_PROMPT")),
		title:        os.Getenv("AGENT_TITLE"),
		workDir:      workDir,
		model:        model,
		prWriter:     os.Getenv("PR_WRITER_MODEL"),
		repoURL:      os.Getenv("REPO_URL"),
		branch:       os.Getenv("BRANCH"),
		maxTurns:     maxTurns,
		gitName:      os.Getenv("GIT_NAME"),
		gitEmail:     os.Getenv("GIT_EMAIL"),
		provider:     detectProvider(),
		issueNumber:  issueNumber,
		issueRepo:    os.Getenv("GITHUB_REPO"),
		agentBranch:  os.Getenv("AGENT_BRANCH"),
		baseBranch:   baseBranch,
		interactive:  os.Getenv("INTERACTIVE") == "1",
		inputURL:     os.Getenv("BANDOLIER_INPUT_URL"),
	}, nil
}

// ── GitHub issue helpers ──────────────────────────────────────────────────────

type githubIssue struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Body   string `json:"body"`
}

func fetchIssue(ctx context.Context, workDir, issueNumber string) (*githubIssue, error) {
	cmd := exec.CommandContext(ctx, "gh", "issue", "view", issueNumber, "--json", "number,title,body")
	cmd.Dir = workDir
	cmd.Env = os.Environ()
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh issue view: %w", err)
	}
	var issue githubIssue
	if err := json.Unmarshal(out, &issue); err != nil {
		return nil, fmt.Errorf("parse issue JSON: %w", err)
	}
	return &issue, nil
}

var nonAlphanumRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	slug := nonAlphanumRe.ReplaceAllString(strings.ToLower(s), "-")
	slug = strings.Trim(slug, "-")
	// Keep branch names short.
	if len(slug) > 24 {
		slug = strings.Trim(slug[:24], "-")
	}
	if slug == "" {
		slug = "task"
	}
	return slug
}

// shortUnique returns a short base-36 suffix from the current time, keeping
// branches unique across runs without bloating the name.
func shortUnique() string {
	s := strconv.FormatInt(time.Now().UnixNano(), 36)
	return s[len(s)-6:]
}

// issueBranchName is a fallback only; the server normally generates the unique
// branch and passes it via AGENT_BRANCH (see lib/issue-prompt.ts).
func issueBranchName(number int, title string) string {
	return fmt.Sprintf("issue-%d-%s-%s", number, slugify(title), shortUnique())
}

func repoBranchName(title string) string {
	return fmt.Sprintf("bandolier/%s-%s", slugify(title), shortUnique())
}

// buildRepoSystemPrompt is the instructional framing for a freeform dashboard
// task: the working agreement that lets the harness reliably open a PR. It is
// appended to Claude's system prompt; the user's task stays the user message.
func buildRepoSystemPrompt(branchName string) string {
	return fmt.Sprintf(`## Working agreement

The repository has been cloned. You are on branch "%s" — do not switch branches.

When you have completed the task in the user message:
1. Commit all your changes:
   git add -A
   git commit -s -m "<concise summary of what you did>"

Do NOT push or open a pull request — the harness will do that once you finish.
Do not ask for clarification. Implement the best solution you can.`,
		branchName)
}

// buildIssueSystemPrompt is the instructional framing for issue mode: the
// objective, branch rules, and commit steps that surround the issue context.
// It mirrors buildIssueSystemPrompt in lib/issue-prompt.ts — keep in sync. The
// issue itself is delivered as the user message (see buildIssueUserMessage).
func buildIssueSystemPrompt(issue *githubIssue, branchName string) string {
	return fmt.Sprintf(`You are an AI agent working on a GitHub issue. The issue is provided in the user message.

## Your objective

Implement a complete solution for the issue.

The repository has been cloned. You are on branch "%s" — do not switch branches.

Steps:
1. Explore the codebase to understand the existing patterns
2. Implement a working solution for the issue
3. Commit all changes:
   git add -A
   git commit -s -m "%s"

Do NOT push or open a pull request — the harness will do that once you finish.
Do not ask for clarification. Implement the best solution you can.`,
		branchName, issue.Title)
}

// buildIssueUserMessage is the user message for issue mode: the issue context
// itself plus optional operator-supplied context from the dashboard task field.
// It mirrors buildIssueUserMessage in lib/issue-prompt.ts — keep in sync.
func buildIssueUserMessage(issue *githubIssue, extraContext string) string {
	body := strings.TrimSpace(issue.Body)
	if body == "" {
		body = "(no description provided)"
	}
	message := fmt.Sprintf(`## Issue #%d: %s

%s`, issue.Number, issue.Title, body)

	if c := strings.TrimSpace(extraContext); c != "" {
		message += fmt.Sprintf("\n\n## Additional context from the operator\n\n%s", c)
	}
	return message
}

// hasCommits reports whether branchName has diverged from the base branch,
// i.e. whether Claude actually committed anything worth opening a PR for.
func hasCommits(ctx context.Context, cfg config, branchName string) bool {
	cmd := exec.CommandContext(ctx, "git", "rev-list", "--count",
		fmt.Sprintf("origin/%s..%s", cfg.baseBranch, branchName))
	cmd.Dir = cfg.workDir
	cmd.Env = os.Environ()
	out, err := cmd.Output()
	if err != nil {
		// If we can't tell, assume there's something to push.
		return true
	}
	return strings.TrimSpace(string(out)) != "0"
}

// latestCommitSubject returns the subject line of the most recent commit on
// branchName — used as a PR title that summarizes what Claude actually changed.
func latestCommitSubject(ctx context.Context, cfg config, branchName string) string {
	cmd := exec.CommandContext(ctx, "git", "log", "-1", "--format=%s", branchName)
	cmd.Dir = cfg.workDir
	cmd.Env = os.Environ()
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// maxPRDiffBytes caps how much of the diff is sent to the PR-writer model, to
// keep the prompt within a reasonable size on large changes.
const maxPRDiffBytes = 60_000

// generatePRContent uses the out-of-band PR-writer model (cfg.prWriter, the
// latest Sonnet) to write a PR title and description from the branch's commits,
// independent of the model that performed the task. Returns ("", "") on any
// failure so the caller keeps its baseline title/body.
func generatePRContent(ctx context.Context, cfg config, branchName string) (string, string) {
	rng := fmt.Sprintf("origin/%s..%s", cfg.baseBranch, branchName)
	gitLog, _ := captureCmd(ctx, cfg.workDir, "git", "log", rng, "--pretty=format:- %s%n%b")
	diffstat, _ := captureCmd(ctx, cfg.workDir, "git", "diff", "--stat", rng)
	diff, _ := captureCmd(ctx, cfg.workDir, "git", "diff", rng)
	if len(diff) > maxPRDiffBytes {
		diff = diff[:maxPRDiffBytes] + "\n…(diff truncated)…"
	}

	prompt := fmt.Sprintf(`Write a GitHub pull request title and description for the changes below, based ONLY on what the commits and diff actually show. Be accurate and concise; do not invent changes or mention the task prompt.

Respond in EXACTLY this format, with no preamble and no code fences:
TITLE: <single-line imperative title, ~70 chars max>
BODY:
<markdown description: a one or two sentence summary, then a "## Changes" section with a bullet list of the notable changes>

=== COMMITS ===
%s

=== DIFFSTAT ===
%s

=== DIFF ===
%s`, strings.TrimSpace(gitLog), strings.TrimSpace(diffstat), diff)

	// Bound the call so a slow or hung model never blocks the run indefinitely.
	genCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	log.Printf("[harness] writing PR title/description with %s", cfg.prWriter)
	out, err := captureCmdEnv(genCtx, cfg.workDir, buildEnv(cfg.provider),
		"claude", "--print",
		"--model", cfg.prWriter,
		"--max-turns", "1",
		"--dangerously-skip-permissions",
		prompt)
	if err != nil {
		log.Printf("[harness] warn: PR copy generation failed: %v", err)
		return "", ""
	}
	return parsePRContent(out)
}

// parsePRContent extracts the title and body from the PR-writer model's reply,
// which is expected in the form "TITLE: ...\nBODY:\n...". Returns ("", "") if no
// title marker is found so the caller falls back to its baseline copy.
func parsePRContent(out string) (string, string) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	var title string
	bodyIdx := -1
	for i, ln := range lines {
		t := strings.TrimSpace(ln)
		if title == "" && strings.HasPrefix(t, "TITLE:") {
			title = strings.TrimSpace(strings.TrimPrefix(t, "TITLE:"))
			continue
		}
		if t == "BODY:" {
			bodyIdx = i + 1
			break
		}
	}
	if title == "" {
		return "", ""
	}
	var body string
	if bodyIdx >= 0 && bodyIdx < len(lines) {
		body = strings.TrimSpace(strings.Join(lines[bodyIdx:], "\n"))
	}
	return title, body
}

// ensureCloses guarantees the PR body references the issue with a closing
// keyword, so merging the PR auto-closes the issue even after the body has been
// rewritten by the PR-writer model.
func ensureCloses(body, issueNumber string) string {
	if strings.Contains(strings.ToLower(body), "closes #"+issueNumber) {
		return body
	}
	if strings.TrimSpace(body) == "" {
		return fmt.Sprintf("Closes #%s\n\nGenerated by Bandolier.", issueNumber)
	}
	return fmt.Sprintf("Closes #%s\n\n%s", issueNumber, body)
}

// installSignoffHook writes a global prepare-commit-msg hook that appends a
// `Signed-off-by` trailer matching the configured git identity to every commit
// (the same trailer `git commit -s` adds), unless one is already present. It
// returns the hooks directory to wire in via core.hooksPath. The directory is
// outside the cloned repo so `git add -A` never stages it.
func installSignoffHook() (string, error) {
	hooksDir := filepath.Join(os.TempDir(), "bandolier-githooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		return "", fmt.Errorf("create hooks dir: %w", err)
	}
	const hook = `#!/bin/sh
# Append a Signed-off-by trailer matching the git identity (DCO), like
# 'git commit -s', unless the commit message already has one.
name="$(git config user.name)"
email="$(git config user.email)"
[ -n "$name" ] || exit 0
git interpret-trailers --if-exists doNothing \
	--trailer "Signed-off-by: $name <$email>" --in-place "$1"
`
	path := filepath.Join(hooksDir, "prepare-commit-msg")
	if err := os.WriteFile(path, []byte(hook), 0o755); err != nil {
		return "", fmt.Errorf("write commit hook: %w", err)
	}
	return hooksDir, nil
}

// openPR pushes the branch and opens a pull request.
func openPR(ctx context.Context, cfg config, branchName, title, body string) {
	if !hasCommits(ctx, cfg, branchName) {
		log.Printf("[harness] no commits on %s — skipping pull request", branchName)
		return
	}

	log.Printf("[harness] pushing branch %s", branchName)
	if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", "push", "-u", "origin", branchName); err != nil {
		log.Printf("[harness] warn: git push failed: %v", err)
		return // no point trying gh pr create if the branch isn't pushed
	}

	log.Printf("[harness] creating pull request: %s", title)
	out, err := captureCmd(ctx, cfg.workDir,
		"gh", "pr", "create",
		"--title", title,
		"--body", body,
		"--base", cfg.baseBranch,
		"--head", branchName,
	)
	if err != nil {
		// A PR for this branch may already exist; log and continue.
		log.Printf("[harness] warn: gh pr create: %v", err)
	}

	// Emit the PR URL with a stable marker so the dashboard can surface it.
	if url := prURLRe.FindString(out); url != "" {
		log.Printf("[harness] PR_URL=%s", url)
	} else {
		log.Printf("[harness] pull request created (no URL parsed)")
	}
}

var prURLRe = regexp.MustCompile(`https://github\.com/\S+/pull/\d+`)

// captureCmd runs a command capturing stdout (returned), while streaming stderr
// into the tagged harness logs.
func captureCmd(ctx context.Context, dir, name string, args ...string) (string, error) {
	return captureCmdEnv(ctx, dir, os.Environ(), name, args...)
}

// captureCmdEnv is captureCmd with an explicit environment (e.g. the Bedrock-
// flagged env for an out-of-band claude invocation).
func captureCmdEnv(ctx context.Context, dir string, env []string, name string, args ...string) (string, error) {
	w := &prefixWriter{}
	var stdout bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdout = &stdout
	cmd.Stderr = w
	err := cmd.Run()
	w.flush()
	return stdout.String(), err
}

// ── Subprocess environment ────────────────────────────────────────────────────

func buildEnv(provider providerKind) []string {
	env := os.Environ()
	if provider == providerBedrock {
		env = setEnvIfMissing(env, "CLAUDE_CODE_USE_BEDROCK", "1")
	}
	return env
}

func setEnvIfMissing(env []string, key, value string) []string {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return env
		}
	}
	return append(env, prefix+value)
}

// ── Core logic ────────────────────────────────────────────────────────────────

func run(ctx context.Context, cfg config) error {
	if err := os.MkdirAll(cfg.workDir, 0o755); err != nil {
		return fmt.Errorf("create working directory: %w", err)
	}

	// Provider logging.
	switch cfg.provider {
	case providerBedrock:
		log.Printf("[harness] provider: AWS Bedrock (region=%s, model=%s)", os.Getenv("AWS_REGION"), cfg.model)
	case providerAnthropic:
		log.Printf("[harness] provider: Anthropic API (model=%s)", cfg.model)
	default:
		log.Printf("[harness] warn: no LLM credentials found — claude will likely fail")
	}

	// Git identity.
	name := cfg.gitName
	if name == "" {
		name = "Claude Agent"
	}
	email := cfg.gitEmail
	if email == "" {
		email = "claude-agent@bandolier.local"
	}

	// Sign off every commit (DCO) regardless of how the agent commits, via a
	// prepare-commit-msg hook — equivalent to always passing `git commit -s`. The
	// hooks dir lives outside the work tree so it isn't itself committed.
	hooksDir, err := installSignoffHook()
	if err != nil {
		return err
	}

	for _, args := range [][]string{
		{"config", "--global", "user.name", name},
		{"config", "--global", "user.email", email},
		{"config", "--global", "core.hooksPath", hooksDir},
		// The workspace emptyDir is chowned to root:fsGroup by Kubernetes, so the
		// repo dir isn't owned by our uid. Mark it safe to avoid git's dubious
		// ownership check failing every git command.
		{"config", "--global", "--add", "safe.directory", cfg.workDir},
	} {
		if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", args...); err != nil {
			return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
		}
	}

	// GitHub token → git credential helper.
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		helper := `!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f`
		if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", "config", "--global", "credential.helper", helper); err != nil {
			log.Printf("[harness] warn: could not set git credential helper: %v", err)
		}
	}

	// Clone repository if specified.
	if cfg.repoURL != "" {
		branchLabel := cfg.branch
		if branchLabel == "" {
			branchLabel = "default"
		}
		log.Printf("[harness] cloning %s (branch: %s)", cfg.repoURL, branchLabel)
		cloneArgs := []string{"clone", "--depth=1"}
		if cfg.branch != "" {
			cloneArgs = append(cloneArgs, "--branch", cfg.branch)
		}
		cloneArgs = append(cloneArgs, cfg.repoURL, ".")
		if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", cloneArgs...); err != nil {
			return fmt.Errorf("git clone: %w", err)
		}
	}

	// Determine the working mode. A PR is opened when prBranch is non-empty.
	var prBranch, prTitle, prBody string

	switch {
	case cfg.issueNumber != "":
		// ── Issue mode ──────────────────────────────────────────────────────────
		log.Printf("[harness] issue mode: #%s", cfg.issueNumber)
		issue, err := fetchIssue(ctx, cfg.workDir, cfg.issueNumber)
		if err != nil {
			return fmt.Errorf("fetch issue: %w", err)
		}
		log.Printf("[harness] issue #%d: %s", issue.Number, issue.Title)

		// The server generates the unique working branch and passes it; only fall
		// back to computing one if it's missing.
		prBranch = cfg.agentBranch
		if prBranch == "" {
			prBranch = issueBranchName(issue.Number, issue.Title)
		}
		prTitle = issue.Title
		prBody = fmt.Sprintf("Closes #%d\n\nGenerated by Bandolier.", issue.Number)
		// The server builds the prompt and passes the issue context as CLAUDE_TASK
		// and the instructional framing as CLAUDE_SYSTEM_PROMPT; only fall back to
		// building them here if they're somehow missing.
		if strings.TrimSpace(cfg.task) == "" {
			cfg.task = buildIssueUserMessage(issue, "")
		}
		if cfg.systemPrompt == "" {
			cfg.systemPrompt = buildIssueSystemPrompt(issue, prBranch)
		}

	case cfg.repoURL != "":
		// ── Repo mode (dashboard deploy against a repository) ────────────────────
		log.Printf("[harness] repo mode")
		branchLabel := cfg.title
		if branchLabel == "" {
			branchLabel = "task"
		}
		prBranch = repoBranchName(branchLabel)
		// Placeholder title; replaced with the commit summary after Claude runs.
		prTitle = "Bandolier agent changes"
		prBody = "Generated by Bandolier."
		// Interactive sessions are framed below (the user drives commits over many
		// turns); only one-shot repo tasks get the commit-and-finish working
		// agreement, kept out of the user message as a system prompt.
		if !cfg.interactive {
			cfg.systemPrompt = buildRepoSystemPrompt(prBranch)
		}

	default:
		log.Printf("[harness] plain mode (no repository)")
	}

	// Create and switch to the working branch for PR-producing modes.
	if prBranch != "" {
		log.Printf("[harness] creating branch %s", prBranch)
		if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", "checkout", "-b", prBranch); err != nil {
			return fmt.Errorf("git checkout -b %s: %w", prBranch, err)
		}
	}

	// ── Run Claude ────────────────────────────────────────────────────────────
	if cfg.interactive {
		// Interactive session: drive Claude over streaming JSON and pause for the
		// user's next message between turns. The session framing goes in the system
		// prompt so the user's messages stay unadorned. Issue mode already set its
		// own system prompt above.
		if cfg.issueNumber == "" {
			cfg.systemPrompt = buildInteractiveSystemPrompt(prBranch)
		}
		log.Printf("[harness] interactive mode (model=%s)", cfg.model)
		if err := runClaudeInteractive(ctx, cfg, cfg.task); err != nil {
			if ctx.Err() != nil {
				log.Printf("[harness] terminated by signal")
				return nil
			}
			return fmt.Errorf("claude: %w", err)
		}
	} else {
		// stream-json emits NDJSON events as they happen so output appears
		// incrementally rather than all at once when the run finishes.
		claudeArgs := []string{
			"--print",
			"--model", cfg.model,
			"--dangerously-skip-permissions",
			"--output-format", "stream-json",
			"--verbose", // required for stream-json in print mode
		}
		if cfg.maxTurns != "" {
			claudeArgs = append(claudeArgs, "--max-turns", cfg.maxTurns)
		}
		// The instructional framing surrounding the task goes in the system prompt
		// so the user message stays the raw issue/form context.
		if cfg.systemPrompt != "" {
			claudeArgs = append(claudeArgs, "--append-system-prompt", cfg.systemPrompt)
		}
		claudeArgs = append(claudeArgs, cfg.task)

		// Log the system prompt and prompt line-by-line so each line keeps the
		// [harness] tag (the dashboard dims harness lines; an untagged multi-line
		// block would render as Claude output).
		if cfg.systemPrompt != "" {
			log.Printf("[harness] system prompt:")
			for _, line := range strings.Split(cfg.systemPrompt, "\n") {
				log.Printf("[harness]   %s", line)
			}
		}
		log.Printf("[harness] starting claude with prompt:")
		for _, line := range strings.Split(cfg.task, "\n") {
			log.Printf("[harness]   %s", line)
		}
		if err := runClaudeStreaming(ctx, cfg.workDir, buildEnv(cfg.provider), claudeArgs...); err != nil {
			if ctx.Err() != nil {
				log.Printf("[harness] terminated by signal")
				return nil
			}
			return fmt.Errorf("claude: %w", err)
		}
	}

	// ── Post-run: push branch and open PR ──────────────────────────────────────
	if prBranch != "" {
		// Baseline title: for dashboard (non-issue) PRs use Claude's commit summary
		// rather than the prompt; issue PRs keep the issue title.
		if cfg.issueNumber == "" {
			if subject := latestCommitSubject(ctx, cfg, prBranch); subject != "" {
				prTitle = subject
			}
		}

		// Out-of-band PR copy: regardless of the task model, have the latest Sonnet
		// (PR_WRITER_MODEL) write the title and description from the actual commits.
		// On any failure this leaves the baseline title/body untouched.
		if cfg.prWriter != "" && hasCommits(ctx, cfg, prBranch) {
			if t, b := generatePRContent(ctx, cfg, prBranch); t != "" {
				prTitle = t
				if strings.TrimSpace(b) != "" {
					prBody = b
				}
			}
		}

		// Always preserve the issue-closing trailer so a merged issue PR closes it,
		// even when the body was rewritten above.
		if cfg.issueNumber != "" {
			prBody = ensureCloses(prBody, cfg.issueNumber)
		}

		openPR(ctx, cfg, prBranch, prTitle, prBody)
	}

	log.Printf("[harness] task complete")
	return nil
}

// prefixWriter re-emits each complete line it receives through log.Printf with
// the [harness] tag, so subprocess output (git, gh) is filtered as harness noise
// in the UI rather than mistaken for Claude's output.
type prefixWriter struct {
	buf []byte
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		log.Printf("[harness] %s", w.buf[:i])
		w.buf = w.buf[i+1:]
	}
	return len(p), nil
}

func (w *prefixWriter) flush() {
	if len(w.buf) > 0 {
		log.Printf("[harness] %s", w.buf)
		w.buf = nil
	}
}

// runCmd runs a harness-orchestrated command (git, gh), tagging its output with
// [harness]. The same writer backs stdout and stderr; exec serializes writes
// when both are the same writer, so lines won't interleave mid-write.
func runCmd(ctx context.Context, dir string, env []string, name string, args ...string) error {
	w := &prefixWriter{}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Stdout = w
	cmd.Stderr = w
	cmd.Env = env
	err := cmd.Run()
	w.flush()
	return err
}

// claudeEvent is the subset of Claude Code's stream-json events we render.
type claudeEvent struct {
	Type     string `json:"type"`
	NumTurns int    `json:"num_turns"`
	IsError  bool   `json:"is_error"`
	Message  struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	} `json:"message"`
}

// toolSummary renders the concrete invocation for a tool_use — the actual
// command/path/pattern that was run, not just the tool name.
func toolSummary(name string, input json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(input, &m); err != nil || len(m) == 0 {
		return name
	}
	str := func(k string) string {
		s, _ := m[k].(string)
		return s
	}
	switch {
	case str("command") != "": // Bash
		return fmt.Sprintf("%s: %s", name, str("command"))
	case str("file_path") != "": // Read / Write / Edit / NotebookEdit
		return fmt.Sprintf("%s: %s", name, str("file_path"))
	case str("path") != "": // Glob / Grep / LS
		if p := str("pattern"); p != "" {
			return fmt.Sprintf("%s: %s in %s", name, p, str("path"))
		}
		return fmt.Sprintf("%s: %s", name, str("path"))
	case str("pattern") != "": // Glob / Grep without path
		return fmt.Sprintf("%s: %s", name, str("pattern"))
	case str("url") != "": // WebFetch
		return fmt.Sprintf("%s: %s", name, str("url"))
	case str("query") != "": // WebSearch
		return fmt.Sprintf("%s: %s", name, str("query"))
	default:
		b, _ := json.Marshal(m)
		return fmt.Sprintf("%s: %s", name, string(b))
	}
}

// logToolUse logs a tool invocation, tagging every line with [harness] so a
// multi-line command (e.g. a heredoc) still renders entirely as harness context.
func logToolUse(name string, input json.RawMessage) {
	lines := strings.Split(toolSummary(name, input), "\n")
	log.Printf("[harness] → %s", lines[0])
	for _, l := range lines[1:] {
		log.Printf("[harness]     %s", l)
	}
}

// handleClaudeEvent renders one NDJSON event. Assistant text is written to
// stdout untagged so the dashboard highlights it; tool use and lifecycle events
// are tagged [harness] so they render as dimmed context.
func handleClaudeEvent(raw []byte) {
	var ev claudeEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		return // ignore anything that isn't a JSON event
	}
	switch ev.Type {
	case "assistant":
		for _, c := range ev.Message.Content {
			switch c.Type {
			case "text":
				if t := strings.TrimSpace(c.Text); t != "" {
					fmt.Fprintln(stdoutTee, t)
				}
			case "tool_use":
				logToolUse(c.Name, c.Input)
			}
		}
	case "result":
		if ev.IsError {
			log.Printf("[harness] claude finished with error (turns=%d)", ev.NumTurns)
		} else {
			log.Printf("[harness] claude finished (turns=%d)", ev.NumTurns)
		}
	}
}

// runClaudeStreaming runs claude with NDJSON streaming output, rendering each
// event as it arrives so progress shows up incrementally instead of all at once.
func runClaudeStreaming(ctx context.Context, dir string, env []string, args ...string) error {
	stderr := &prefixWriter{}
	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stderr = stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	// ReadBytes (not Scanner) avoids line-length limits — stream-json lines can
	// be large when they embed tool inputs or file contents.
	reader := bufio.NewReader(stdout)
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			handleClaudeEvent(line)
		}
		if readErr != nil {
			break
		}
	}

	waitErr := cmd.Wait()
	stderr.flush()
	return waitErr
}

// ── Interactive mode ────────────────────────────────────────────────────────────

// endSessionSentinel is the input message that ends an interactive session.
// Kept in sync with the server's matching constant (agents router).
const endSessionSentinel = "__BANDOLIER_END_SESSION__"

// Log markers the dashboard parses to know whether an interactive agent is
// currently waiting for the user. Kept in sync with the agents router.
const (
	awaitInputMarker = "BANDOLIER_AWAIT_INPUT"
	resumeMarker     = "BANDOLIER_RESUME"
)

// interactiveIdleTimeout bounds how long the session waits for the user before
// ending itself, so an abandoned session doesn't run forever.
func interactiveIdleTimeout() time.Duration {
	if v := os.Getenv("INTERACTIVE_IDLE_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return 30 * time.Minute
}

// buildInteractiveSystemPrompt frames an interactive session: a short note
// about how the session works and the working branch. It is appended to
// Claude's system prompt so the user's messages stay unadorned. Returns "" when
// there's no working branch (plain mode), leaving the default system prompt.
func buildInteractiveSystemPrompt(branchName string) string {
	if branchName == "" {
		return ""
	}
	return fmt.Sprintf(`This is an interactive session: the user will keep sending follow-up messages, so do not assume you must finish everything in one turn. The repository is cloned and you are on branch %q — do not switch branches. Commit changes as we go (git add -A && git commit). When the session ends, the harness pushes the branch and opens a pull request if there are commits.`, branchName)
}

// runClaudeInteractive drives a long-lived `claude` process over streaming JSON:
// it sends the first message, renders streamed output, and after each turn waits
// for the next user message (polled from Bandolier) before continuing. The
// session ends on the end sentinel, an idle timeout, or context cancellation.
func runClaudeInteractive(ctx context.Context, cfg config, first string) error {
	args := []string{
		"--print",
		"--model", cfg.model,
		"--dangerously-skip-permissions",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
	}
	if cfg.systemPrompt != "" {
		args = append(args, "--append-system-prompt", cfg.systemPrompt)
	}
	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = cfg.workDir
	cmd.Env = buildEnv(cfg.provider)
	stderr := &prefixWriter{}
	cmd.Stderr = stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	// Reader goroutine: render every event and signal when a turn completes (a
	// `result` event means Claude is idle, waiting for the next stdin message).
	turnDone := make(chan struct{}, 1)
	go func() {
		reader := bufio.NewReader(stdout)
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(bytes.TrimSpace(line)) > 0 {
				handleClaudeEvent(line)
				if isResultEvent(line) {
					select {
					case turnDone <- struct{}{}:
					default:
					}
				}
			}
			if readErr != nil {
				return
			}
		}
	}()

	log.Printf("[harness] sending initial message")
	if err := writeUserMessage(stdin, first); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		return fmt.Errorf("write initial message: %w", err)
	}

	idle := interactiveIdleTimeout()
	for {
		select {
		case <-ctx.Done():
			_ = stdin.Close()
			_ = cmd.Wait()
			return nil
		case <-turnDone:
		}

		// Turn finished — wait for the user's next message.
		log.Printf("[harness] %s", awaitInputMarker)
		content, ended := awaitInput(ctx, cfg, idle)
		if ended {
			log.Printf("[harness] interactive session ending")
			break
		}
		log.Printf("[harness] %s", resumeMarker)
		if err := writeUserMessage(stdin, content); err != nil {
			log.Printf("[harness] warn: write message failed: %v", err)
			break
		}
	}

	// Closing stdin tells `claude` to exit; then run the post-run PR step.
	_ = stdin.Close()
	waitErr := cmd.Wait()
	stderr.flush()
	if ctx.Err() != nil {
		return nil
	}
	return waitErr
}

// awaitInput polls Bandolier for the next user message. It returns ended=true on
// the end sentinel, the idle timeout, or context cancellation.
func awaitInput(ctx context.Context, cfg config, idle time.Duration) (string, bool) {
	deadline := time.Now().Add(idle)
	for {
		if ctx.Err() != nil {
			return "", true
		}
		content, ok, err := pollInput(ctx, cfg)
		if err != nil {
			log.Printf("[harness] warn: input poll failed: %v", err)
		} else if ok {
			if content == endSessionSentinel {
				return "", true
			}
			return content, false
		}
		if time.Now().After(deadline) {
			log.Printf("[harness] no input for %s — ending interactive session", idle)
			return "", true
		}
		select {
		case <-ctx.Done():
			return "", true
		case <-time.After(2 * time.Second):
		}
	}
}

// pollInput fetches the next queued user message from Bandolier, returning
// ok=false when the queue is empty (HTTP 204).
func pollInput(ctx context.Context, cfg config) (string, bool, error) {
	if cfg.inputURL == "" {
		return "", false, fmt.Errorf("no input URL configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.inputURL, nil)
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("BANDOLIER_INGEST_TOKEN"))
	req.Header.Set("X-Bandolier-Job", os.Getenv("BANDOLIER_JOB"))

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return "", false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("input poll status %d", resp.StatusCode)
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", false, err
	}
	return body.Content, true, nil
}

// writeUserMessage writes one streaming-JSON user message line to Claude's stdin.
func writeUserMessage(w io.Writer, text string) error {
	msg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": text}},
		},
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

// isResultEvent reports whether a stream-json line is a turn-completion event.
func isResultEvent(raw []byte) bool {
	var ev struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return false
	}
	return ev.Type == "result"
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.Ltime)
	// Mirror all pod-log output into the transcript so it can be persisted.
	log.SetOutput(io.MultiWriter(os.Stderr, transcript))
	stdoutTee = io.MultiWriter(os.Stdout, transcript)

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("[harness] config error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("[harness] received %v, shutting down", sig)
		cancel()
	}()

	runErr := run(ctx, cfg)
	// Persist the transcript regardless of success/failure before exiting.
	uploadTranscript()
	if runErr != nil {
		log.Fatalf("[harness] error: %v", runErr)
	}
}
