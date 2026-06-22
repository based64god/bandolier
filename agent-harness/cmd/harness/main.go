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

// outputPRURL / outputIssueURL hold the run's structured output (the pull
// request or issue the harness produced). They're reported to Bandolier via the
// ingest callback so a finished run's output is recoverable from the database
// even after the pod — and its logs — are gone.
var (
	outputPRURL    string
	outputIssueURL string
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
	// Report the run's structured output alongside the transcript so it's
	// persisted durably — pod logs (the live source) vanish with the pod.
	if outputPRURL != "" {
		req.Header.Set("X-Bandolier-PR-URL", outputPRURL)
	}
	if outputIssueURL != "" {
		req.Header.Set("X-Bandolier-Issue-URL", outputIssueURL)
	}

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
	providerAnthropic              // direct Anthropic API (claude CLI)
	providerBedrock                // AWS Bedrock (claude CLI)
	providerOpenAI                 // OpenAI API (codex CLI)
	providerGemini                 // Google Gemini models via the Antigravity CLI (agy)
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
	if os.Getenv("OPENAI_API_KEY") != "" {
		return providerOpenAI
	}
	if os.Getenv("GOOGLE_PROJECT_CREDENTIALS") != "" ||
		os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" ||
		os.Getenv("ANTIGRAVITY_API_KEY") != "" ||
		os.Getenv("GEMINI_API_KEY") != "" ||
		os.Getenv("GOOGLE_API_KEY") != "" {
		return providerGemini
	}
	return providerNone
}

// ── Config ────────────────────────────────────────────────────────────────────

type config struct {
	task         string
	systemPrompt string // instructional framing appended to Claude's system prompt
	// repoSystemPrompt is the admin-configured, repo-attached system prompt
	// (REPO_SYSTEM_PROMPT): a blanket instruction layered on top of whatever
	// framing the harness builds, for every run/provider/mode. Empty = none.
	repoSystemPrompt string
	title            string // short label used for branch slug, PR title, commit message
	workDir          string
	model            string
	prWriter         string // out-of-band model for writing the PR title/description
	repoURL          string
	branch           string
	maxTurns         string
	gitName          string
	gitEmail         string
	provider         providerKind
	issueNumber      string // GitHub issue number (issue mode)
	issueRepo        string // "owner/repo" for gh commands
	agentBranch      string // server-provided unique working branch (issue mode)
	baseBranch       string // base branch for the PR
	interactive      bool   // long-lived session driven by user input between turns
	inputURL         string // Bandolier endpoint the interactive loop polls for input
	outputType       string // "pr" (default) or "issue": what the run produces when done
}

// issueOutput reports whether the run should produce a GitHub issue instead of a
// pull request: the agent analyses the task/repo (no branch, no commits) and the
// harness opens an issue written from the transcript by the writer model.
func (c config) issueOutput() bool { return c.outputType == "issue" }

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

	// Default to opening a pull request; "issue" makes the run produce a GitHub
	// issue (sub-task) instead.
	outputType := os.Getenv("OUTPUT_TYPE")
	if outputType == "" {
		outputType = "pr"
	}

	return config{
		task:             task,
		systemPrompt:     strings.TrimSpace(os.Getenv("CLAUDE_SYSTEM_PROMPT")),
		repoSystemPrompt: strings.TrimSpace(os.Getenv("REPO_SYSTEM_PROMPT")),
		title:            os.Getenv("AGENT_TITLE"),
		workDir:          workDir,
		model:            model,
		prWriter:         os.Getenv("PR_WRITER_MODEL"),
		repoURL:          os.Getenv("REPO_URL"),
		branch:           os.Getenv("BRANCH"),
		maxTurns:         maxTurns,
		gitName:          os.Getenv("GIT_NAME"),
		gitEmail:         os.Getenv("GIT_EMAIL"),
		provider:         detectProvider(),
		issueNumber:      issueNumber,
		issueRepo:        os.Getenv("GITHUB_REPO"),
		agentBranch:      os.Getenv("AGENT_BRANCH"),
		baseBranch:       baseBranch,
		interactive:      os.Getenv("INTERACTIVE") == "1",
		inputURL:         os.Getenv("BANDOLIER_INPUT_URL"),
		outputType:       outputType,
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

// buildIssueOutputSystemPrompt frames an issue-output run: the agent analyses
// the task/repo and the harness opens a single GitHub issue from its findings —
// no code changes, no branch, no PR. When the run was triggered by a parent
// issue (webhook sub-task or a selected issue), it's referenced so the agent
// scopes the issue as a concrete sub-task of it.
func buildIssueOutputSystemPrompt(parent *githubIssue) string {
	scope := `Analyse the task in the user message against the repository.`
	if parent != nil {
		scope = fmt.Sprintf(`Break down parent issue #%d into the single most valuable, concretely-scoped sub-task, analysing the repository as needed.`, parent.Number)
	}
	return fmt.Sprintf(`You are an AI agent that produces a GitHub issue, NOT code.

## Your objective

%s

Do NOT modify files, create branches, commit, or open a pull request — the harness opens the issue for you once you finish. Explore the codebase read-only to ground the issue in real files and patterns.

End your final message with a clear, self-contained write-up of the issue to file: a one-line summary, the motivation, and concrete, actionable steps or acceptance criteria referencing real files. The harness turns that write-up into the issue title and body.
Do not ask for clarification.`, scope)
}

// buildIssueOutputInteractivePrompt frames an interactive issue-output session:
// the user drives the analysis over several turns and the harness opens one
// issue from the conversation when the session ends.
func buildIssueOutputInteractivePrompt() string {
	return `This is an interactive session that produces a GitHub issue, NOT code. The repository is cloned; explore it read-only and do not modify files, commit, or open a pull request. The user will keep sending follow-up messages — refine the issue with them. When the session ends, the harness opens a GitHub issue written from the conversation.`
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

// buildPRPrompt assembles the instruction + commits/diff context the PR-writer
// model turns into a title and description. Shared by the Claude and Codex
// writers so both produce identical copy from the same inputs.
func buildPRPrompt(ctx context.Context, cfg config, branchName string) string {
	// The commit list is the symmetric "reachable from branch but not base"
	// (two-dot) range — exactly the commits this branch adds.
	logRange := fmt.Sprintf("origin/%s..%s", cfg.baseBranch, branchName)
	gitLog, _ := captureCmd(ctx, cfg.workDir, "git", "log", logRange, "--pretty=format:- %s%n%b")

	// The diff and diffstat use a three-dot range so they are computed against
	// the merge-base of the base and working branches, not the base branch tip.
	// A two-dot `git diff` compares the tips directly, so if the base branch has
	// moved on since this branch forked (e.g. the agent fetched/pulled during the
	// run), unrelated base-only commits leak in as spurious reversed changes and
	// can swamp or truncate the real changes — which is what made PR copy
	// generation sometimes fail. The three-dot form diffs only what this branch
	// introduced relative to where it diverged.
	diffRange := fmt.Sprintf("origin/%s...%s", cfg.baseBranch, branchName)
	diffstat, _ := captureCmd(ctx, cfg.workDir, "git", "diff", "--stat", diffRange)
	diff, _ := captureCmd(ctx, cfg.workDir, "git", "diff", diffRange)
	if len(diff) > maxPRDiffBytes {
		diff = diff[:maxPRDiffBytes] + "\n…(diff truncated)…"
	}

	return fmt.Sprintf(`Write a GitHub pull request title and description for the changes below, based ONLY on what the commits and diff actually show. Be accurate and concise; do not invent changes or mention the task prompt.

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
}

// generatePRContent uses the out-of-band PR-writer model (cfg.prWriter, the
// latest Sonnet) to write a PR title and description from the branch's commits,
// independent of the model that performed the task. Returns ("", "") on any
// failure so the caller keeps its baseline title/body.
func generatePRContent(ctx context.Context, cfg config, branchName string) (string, string) {
	return generateWriterContent(ctx, cfg, buildPRPrompt(ctx, cfg, branchName))
}

// generateWriterContent runs the out-of-band writer model (cfg.prWriter, the
// latest Sonnet, falling back to the task model) on an arbitrary TITLE/BODY
// prompt — shared by the PR-copy and issue-copy writers. Returns ("", "") on any
// failure so callers keep their baseline copy.
func generateWriterContent(ctx context.Context, cfg config, prompt string) (string, string) {
	writerModel := cfg.prWriter
	if writerModel == "" {
		writerModel = cfg.model
	}

	// Bound the call so a slow or hung model never blocks the run indefinitely.
	genCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	log.Printf("[harness] writing title/description with %s", writerModel)
	out, err := captureCmdEnv(genCtx, cfg.workDir, buildEnv(cfg.provider),
		"claude", "--print",
		"--model", writerModel,
		"--max-turns", "1",
		"--dangerously-skip-permissions",
		prompt)
	if err != nil {
		log.Printf("[harness] warn: copy generation failed: %v", err)
		return "", ""
	}
	return parsePRContent(out)
}

// generatePRContentCodex is the Codex equivalent of generatePRContent for OpenAI
// runs: it asks a cheap same-provider writer model to write the PR copy via
// `codex exec`, capturing only the final message with --output-last-message.
// The writer is PR_WRITER_MODEL (the latest GPT mini) when the server set one,
// falling back to the task model. Returns ("", "") on any failure so the caller
// keeps its baseline title/body.
func generatePRContentCodex(ctx context.Context, cfg config, branchName string) (string, string) {
	return generateWriterContentCodex(ctx, cfg, buildPRPrompt(ctx, cfg, branchName))
}

// generateWriterContentCodex is the Codex equivalent of generateWriterContent:
// it runs a cheap same-provider writer on a TITLE/BODY prompt via `codex exec`.
func generateWriterContentCodex(ctx context.Context, cfg config, prompt string) (string, string) {
	writerModel := cfg.prWriter
	if writerModel == "" {
		writerModel = cfg.model
	}

	genCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	// Capture the final assistant message to a file rather than scraping stdout,
	// which also carries Codex's progress output.
	outFile := filepath.Join(os.TempDir(), "codex-pr-"+shortUnique()+".txt")
	defer os.Remove(outFile)

	log.Printf("[harness] writing PR title/description with codex (%s)", writerModel)
	_, err := captureCmdEnv(genCtx, cfg.workDir, buildEnv(cfg.provider),
		"codex", "exec",
		"--model", writerModel,
		"--ephemeral",
		"--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox",
		"--output-last-message", outFile,
		prompt)
	if err != nil {
		log.Printf("[harness] warn: codex PR copy generation failed: %v", err)
		return "", ""
	}
	out, readErr := os.ReadFile(outFile)
	if readErr != nil {
		log.Printf("[harness] warn: reading codex PR message failed: %v", readErr)
		return "", ""
	}
	return parsePRContent(string(out))
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

// claudeCoauthorPattern is the extended-regex (grep -E) used to drop
// `Co-authored-by:` trailers that attribute a commit to Claude or another AI
// assistant, so the only authors on a pushed commit are the GitHub OAuth user.
// Matched case-insensitively against each line of the commit message.
const claudeCoauthorPattern = `^[[:space:]]*co-authored-by:.*(claude|anthropic|noreply@anthropic\.com)`

// rewriteCommitAuthors rewrites every commit the branch adds over the base so
// its author and committer are the GitHub OAuth identity (name/email), and
// strips any `Co-authored-by:` trailer naming Claude/Anthropic. This runs before
// the branch is pushed and a PR opened so commits are attributed solely to the
// acting user, never to the agent model. It is a no-op when the branch has no
// commits over the base.
func rewriteCommitAuthors(ctx context.Context, cfg config, branchName, name, email string) error {
	if !hasCommits(ctx, cfg, branchName) {
		return nil
	}

	log.Printf("[harness] rewriting commit authorship on %s to %s <%s>", branchName, name, email)

	// env-filter forces both the author and committer identity on every rewritten
	// commit; msg-filter drops Claude/AI co-author trailers (grep returns non-zero
	// when it emits no lines, so `|| true` keeps an all-stripped message valid).
	envFilter := fmt.Sprintf(
		`export GIT_AUTHOR_NAME=%q GIT_AUTHOR_EMAIL=%q GIT_COMMITTER_NAME=%q GIT_COMMITTER_EMAIL=%q`,
		name, email, name, email,
	)
	msgFilter := fmt.Sprintf(`grep -viE %q || true`, claudeCoauthorPattern)

	// FILTER_BRANCH_SQUELCH_WARNING silences filter-branch's deprecation banner;
	// -f overwrites any stale refs/original/ backup from a previous attempt. The
	// rev-list range limits the rewrite to the commits this branch introduced.
	env := append(os.Environ(), "FILTER_BRANCH_SQUELCH_WARNING=1")
	rangeSpec := fmt.Sprintf("origin/%s..%s", cfg.baseBranch, branchName)
	return runCmd(ctx, cfg.workDir, env, "git", "filter-branch", "-f",
		"--env-filter", envFilter,
		"--msg-filter", msgFilter,
		"--", rangeSpec)
}

// openPR pushes the branch and opens a pull request. It returns an error on a
// genuine failure (push rejected, or `gh pr create` failing for any reason other
// than the PR already existing) so the run is marked failed rather than silently
// reporting success with no PR.
func openPR(ctx context.Context, cfg config, branchName, title, body string) error {
	if !hasCommits(ctx, cfg, branchName) {
		log.Printf("[harness] no commits on %s — skipping pull request", branchName)
		return nil
	}

	log.Printf("[harness] pushing branch %s", branchName)
	if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", "push", "-u", "origin", branchName); err != nil {
		return fmt.Errorf("git push: %w", err)
	}

	log.Printf("[harness] creating pull request: %s", title)
	// Capture stdout+stderr together: gh prints the new PR URL to stdout, but the
	// "already exists" notice (and its URL) to stderr.
	out, err := captureCombined(ctx, cfg.workDir,
		"gh", "pr", "create",
		"--title", title,
		"--body", body,
		"--base", cfg.baseBranch,
		"--head", branchName,
	)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line != "" {
			log.Printf("[harness] %s", line)
		}
	}
	if err != nil {
		// gh exits non-zero when a PR for this branch already exists — that's
		// idempotent success. Any other failure (auth, rate limit, branch
		// protection) is propagated so the run doesn't report a false success.
		if strings.Contains(strings.ToLower(out), "already exists") {
			log.Printf("[harness] pull request already exists for %s", branchName)
		} else {
			return fmt.Errorf("gh pr create: %w", err)
		}
	}

	// Emit the PR URL with a stable marker so the dashboard can surface it, and
	// record it for the ingest callback so it outlives the pod logs.
	if url := prURLRe.FindString(out); url != "" {
		outputPRURL = url
		log.Printf("[harness] PR_URL=%s", url)
	} else {
		log.Printf("[harness] pull request created (no URL parsed)")
	}
	return nil
}

var prURLRe = regexp.MustCompile(`https://github\.com/\S+/pull/\d+`)

var issueURLRe = regexp.MustCompile(`https://github\.com/\S+/issues/\d+`)

// maxIssueTranscriptBytes caps how much of the run transcript is sent to the
// issue-writer model. The agent's write-up lands at the end, so we keep the tail.
const maxIssueTranscriptBytes = 60_000

// buildIssuePrompt assembles the instruction + run transcript the issue-writer
// model turns into an issue title and body. When the run stems from a parent
// issue, the writer is told to scope the new issue as a sub-task of it.
func buildIssuePrompt(transcript string, parent *githubIssue) string {
	if len(transcript) > maxIssueTranscriptBytes {
		transcript = "…(transcript truncated)…\n" + transcript[len(transcript)-maxIssueTranscriptBytes:]
	}
	parentNote := ""
	if parent != nil {
		parentNote = fmt.Sprintf("\nThis is a sub-task of parent issue #%d (%q) — scope and reference it accordingly.\n", parent.Number, parent.Title)
	}
	return fmt.Sprintf(`Write a GitHub issue title and description based ONLY on the agent transcript below — the analysis and the write-up at the end. Be accurate, concrete, and actionable; do not invent work the transcript doesn't support.
%s
Respond in EXACTLY this format, with no preamble and no code fences:
TITLE: <single-line imperative title, ~70 chars max>
BODY:
<markdown description: a one or two sentence summary, then a "## Details" section with the motivation and a bullet list of concrete steps or acceptance criteria>

=== AGENT TRANSCRIPT ===
%s`, parentNote, strings.TrimSpace(transcript))
}

// ensurePartOf guarantees the issue body references its parent issue, so a
// reader can navigate to it even after the body was rewritten by the writer.
func ensurePartOf(body string, parentNumber int) string {
	ref := fmt.Sprintf("Part of #%d", parentNumber)
	if strings.Contains(strings.ToLower(body), strings.ToLower(ref)) {
		return body
	}
	if strings.TrimSpace(body) == "" {
		return ref + "\n\nGenerated by Bandolier."
	}
	return fmt.Sprintf("%s\n\n%s", ref, body)
}

// openIssue writes an issue title/body from the run transcript via the writer
// model and opens a GitHub issue. It returns an error on a genuine `gh` failure
// so the run is marked failed rather than silently reporting success with no
// issue. `parent`, when set, is the originating issue the new one sub-tasks.
func openIssue(ctx context.Context, cfg config, transcript string, parent *githubIssue) error {
	if cfg.issueRepo == "" {
		log.Printf("[harness] no repository for issue creation — skipping issue")
		return nil
	}

	prompt := buildIssuePrompt(transcript, parent)
	var title, body string
	switch cfg.provider {
	case providerOpenAI:
		title, body = generateWriterContentCodex(ctx, cfg, prompt)
	case providerGemini:
		title, body = generateWriterContentGemini(ctx, cfg, prompt)
	default:
		title, body = generateWriterContent(ctx, cfg, prompt)
	}
	if strings.TrimSpace(title) == "" {
		title = "Bandolier agent findings"
	}
	if strings.TrimSpace(body) == "" {
		body = "Generated by Bandolier."
	}
	if parent != nil {
		body = ensurePartOf(body, parent.Number)
	}

	log.Printf("[harness] creating issue: %s", title)
	out, err := captureCombined(ctx, cfg.workDir,
		"gh", "issue", "create",
		"--repo", cfg.issueRepo,
		"--title", title,
		"--body", body,
	)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line != "" {
			log.Printf("[harness] %s", line)
		}
	}
	if err != nil {
		return fmt.Errorf("gh issue create: %w", err)
	}

	// Emit the issue URL with a stable marker so the dashboard can surface it, and
	// record it for the ingest callback so it outlives the pod logs.
	if url := issueURLRe.FindString(out); url != "" {
		outputIssueURL = url
		log.Printf("[harness] ISSUE_URL=%s", url)
	} else {
		log.Printf("[harness] issue created (no URL parsed)")
	}
	return nil
}

// captureCmd runs a command capturing stdout (returned), while streaming stderr
// into the tagged harness logs.
func captureCmd(ctx context.Context, dir, name string, args ...string) (string, error) {
	return captureCmdEnv(ctx, dir, os.Environ(), name, args...)
}

// captureCombined runs a command capturing stdout and stderr together, for
// callers that need to inspect both (e.g. distinguishing a gh "already exists"
// notice on stderr from a real failure).
func captureCombined(ctx context.Context, dir, name string, args ...string) (string, error) {
	var buf bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
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
	switch provider {
	case providerBedrock:
		env = setEnvIfMissing(env, "CLAUDE_CODE_USE_BEDROCK", "1")
	case providerOpenAI:
		// Codex authenticates with OPENAI_API_KEY; mirror it to CODEX_API_KEY,
		// which some Codex versions read instead, so either name works.
		if key := os.Getenv("OPENAI_API_KEY"); key != "" {
			env = setEnvIfMissing(env, "CODEX_API_KEY", key)
		}
	case providerGemini:
		// agy (Antigravity CLI) authenticates against a Google Cloud project via
		// Application Default Credentials. The server injects the project
		// credentials JSON as GOOGLE_PROJECT_CREDENTIALS; materialize it and point
		// agy at it. Legacy *_API_KEY values are still honored as a fallback.
		env = setupGeminiCredentials(env)
	}
	return env
}

// geminiCredentialsPath is where the harness materializes the Google project
// credentials JSON. It lives under ~/.gemini so agy finds it alongside its own
// config; GOOGLE_APPLICATION_CREDENTIALS points the google-genai auth at it.
func geminiCredentialsPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "/root"
	}
	return filepath.Join(home, ".gemini", "credentials.json")
}

// setupGeminiCredentials writes the Google project credentials JSON (injected as
// GOOGLE_PROJECT_CREDENTIALS) to ~/.gemini/credentials.json and sets the env
// agy needs to authenticate against the project: ADC via
// GOOGLE_APPLICATION_CREDENTIALS, Vertex mode, and the project id parsed out of
// the JSON. When no credentials JSON is present it falls back to mirroring a
// legacy GEMINI_API_KEY/GOOGLE_API_KEY into ANTIGRAVITY_API_KEY.
func setupGeminiCredentials(env []string) []string {
	creds := os.Getenv("GOOGLE_PROJECT_CREDENTIALS")
	if creds == "" {
		if os.Getenv("ANTIGRAVITY_API_KEY") == "" {
			if key := os.Getenv("GEMINI_API_KEY"); key != "" {
				env = setEnvIfMissing(env, "ANTIGRAVITY_API_KEY", key)
			} else if key := os.Getenv("GOOGLE_API_KEY"); key != "" {
				env = setEnvIfMissing(env, "ANTIGRAVITY_API_KEY", key)
			}
		}
		return env
	}

	path := geminiCredentialsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.Printf("[harness] warn: could not create %s: %v", filepath.Dir(path), err)
		return env
	}
	if err := os.WriteFile(path, []byte(creds), 0o600); err != nil {
		log.Printf("[harness] warn: could not write Gemini credentials: %v", err)
		return env
	}

	env = setEnvIfMissing(env, "GOOGLE_APPLICATION_CREDENTIALS", path)
	env = setEnvIfMissing(env, "GOOGLE_GENAI_USE_VERTEXAI", "true")
	// Target the project named in the credentials so a second secret isn't needed.
	if proj := projectIDFromCredentials(creds); proj != "" {
		env = setEnvIfMissing(env, "GOOGLE_CLOUD_PROJECT", proj)
	}
	return env
}

// projectIDFromCredentials extracts the project id from a Google credentials
// JSON (service-account key or ADC), preferring project_id and falling back to
// quota_project_id. Returns "" if the JSON can't be parsed or has neither.
func projectIDFromCredentials(creds string) string {
	var parsed struct {
		ProjectID      string `json:"project_id"`
		QuotaProjectID string `json:"quota_project_id"`
	}
	if err := json.Unmarshal([]byte(creds), &parsed); err != nil {
		return ""
	}
	if parsed.ProjectID != "" {
		return parsed.ProjectID
	}
	return parsed.QuotaProjectID
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
	case providerOpenAI:
		log.Printf("[harness] provider: OpenAI Codex (model=%s)", cfg.model)
	case providerGemini:
		log.Printf("[harness] provider: Google Antigravity / Gemini (model=%s)", cfg.model)
	default:
		log.Printf("[harness] warn: no LLM credentials found — the agent will likely fail")
	}

	// Git identity.
	name := cfg.gitName
	if name == "" {
		name = "Bandolier Agent"
	}
	email := cfg.gitEmail
	if email == "" {
		email = "bandolier-agent@bandolier.local"
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

	// Determine the working mode. A PR is opened when prBranch is non-empty; in
	// issue-output mode an issue is opened instead and no branch is created.
	var prBranch, prTitle, prBody string
	// The originating issue, when this run was triggered by one — used to frame
	// the prompt and (for issue output) to link the new issue to its parent.
	var parentIssue *githubIssue
	issueOutput := cfg.issueOutput()

	switch {
	case cfg.issueNumber != "":
		// ── Issue-triggered ──────────────────────────────────────────────────────
		log.Printf("[harness] issue mode: #%s (output=%s)", cfg.issueNumber, cfg.outputType)
		issue, err := fetchIssue(ctx, cfg.workDir, cfg.issueNumber)
		if err != nil {
			return fmt.Errorf("fetch issue: %w", err)
		}
		log.Printf("[harness] issue #%d: %s", issue.Number, issue.Title)
		parentIssue = issue

		// The server passes the issue context as CLAUDE_TASK; only fall back to
		// building it here if it's somehow missing.
		if strings.TrimSpace(cfg.task) == "" {
			cfg.task = buildIssueUserMessage(issue, "")
		}
		if issueOutput {
			// Produce a sub-task issue from the parent: no branch, analysis framing.
			if cfg.systemPrompt == "" {
				cfg.systemPrompt = buildIssueOutputSystemPrompt(issue)
			}
		} else {
			// Produce a PR that closes the issue. The server generates the unique
			// working branch and passes it; only fall back if it's missing.
			prBranch = cfg.agentBranch
			if prBranch == "" {
				prBranch = issueBranchName(issue.Number, issue.Title)
			}
			prTitle = issue.Title
			prBody = fmt.Sprintf("Closes #%d\n\nGenerated by Bandolier.", issue.Number)
			if cfg.systemPrompt == "" {
				cfg.systemPrompt = buildIssueSystemPrompt(issue, prBranch)
			}
		}

	case cfg.repoURL != "":
		// ── Repo mode (dashboard deploy against a repository) ────────────────────
		log.Printf("[harness] repo mode (output=%s)", cfg.outputType)
		if issueOutput {
			// Analysis-only; the harness opens an issue from the findings. The
			// interactive path is framed below.
			if !cfg.interactive {
				cfg.systemPrompt = buildIssueOutputSystemPrompt(nil)
			}
		} else {
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

	// ── Run the agent ───────────────────────────────────────────────────────────
	if cfg.provider == providerOpenAI {
		// OpenAI models run through the Codex CLI rather than claude.
		if cfg.interactive {
			// Frame the session like the claude interactive path (issue mode
			// already set its own system prompt above).
			if cfg.issueNumber == "" {
				cfg.systemPrompt = interactiveFraming(issueOutput, prBranch)
			}
			log.Printf("[harness] interactive mode via codex (model=%s)", cfg.model)
			if err := runCodexInteractive(ctx, cfg, cfg.task); err != nil {
				if ctx.Err() != nil {
					log.Printf("[harness] terminated by signal")
					return nil
				}
				return fmt.Errorf("codex: %w", err)
			}
		} else if err := runCodex(ctx, cfg, prBranch); err != nil {
			if ctx.Err() != nil {
				log.Printf("[harness] terminated by signal")
				return nil
			}
			return fmt.Errorf("codex: %w", err)
		}
	} else if cfg.provider == providerGemini {
		// Gemini models run through the Antigravity CLI (agy).
		if cfg.interactive {
			if cfg.issueNumber == "" {
				cfg.systemPrompt = interactiveFraming(issueOutput, prBranch)
			}
			log.Printf("[harness] interactive mode via agy (model=%s)", cfg.model)
			if err := runGeminiInteractive(ctx, cfg, cfg.task); err != nil {
				if ctx.Err() != nil {
					log.Printf("[harness] terminated by signal")
					return nil
				}
				return fmt.Errorf("gemini: %w", err)
			}
		} else if err := runGemini(ctx, cfg, prBranch); err != nil {
			if ctx.Err() != nil {
				log.Printf("[harness] terminated by signal")
				return nil
			}
			return fmt.Errorf("gemini: %w", err)
		}
	} else if cfg.interactive {
		// Interactive session: drive Claude over streaming JSON and pause for the
		// user's next message between turns. The session framing goes in the system
		// prompt so the user's messages stay unadorned. Issue mode already set its
		// own system prompt above.
		if cfg.issueNumber == "" {
			cfg.systemPrompt = interactiveFraming(issueOutput, prBranch)
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
		// so the user message stays the raw issue/form context. The repo-attached
		// prompt (if any) is layered on after it.
		sysPrompt := cfg.withRepoPrompt(cfg.systemPrompt)
		if sysPrompt != "" {
			claudeArgs = append(claudeArgs, "--append-system-prompt", sysPrompt)
		}
		claudeArgs = append(claudeArgs, cfg.task)

		// Log the system prompt and prompt line-by-line so each line keeps the
		// [harness] tag (the dashboard dims harness lines; an untagged multi-line
		// block would render as Claude output).
		if sysPrompt != "" {
			log.Printf("[harness] system prompt:")
			for _, line := range strings.Split(sysPrompt, "\n") {
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
		// Rewrite authorship to the GitHub OAuth identity (and strip Claude/AI
		// co-author trailers) before anything is pushed, so commits are attributed
		// solely to the acting user. Done first so the commit subject and generated
		// PR copy below reflect the rewritten commits.
		if err := rewriteCommitAuthors(ctx, cfg, prBranch, name, email); err != nil {
			if ctx.Err() != nil {
				log.Printf("[harness] terminated by signal")
				return nil
			}
			return fmt.Errorf("rewrite commit authors: %w", err)
		}

		// Baseline title: for dashboard (non-issue) PRs use Claude's commit summary
		// rather than the prompt; issue PRs keep the issue title.
		if cfg.issueNumber == "" {
			if subject := latestCommitSubject(ctx, cfg, prBranch); subject != "" {
				prTitle = subject
			}
		}

		// Out-of-band PR copy written from the actual commits, independent of the
		// task model. The Claude side uses the latest Sonnet (PR_WRITER_MODEL);
		// OpenAI runs use Codex with the task model (no separate writer model). On
		// any failure this leaves the baseline title/body untouched.
		if hasCommits(ctx, cfg, prBranch) {
			var t, b string
			if cfg.provider == providerOpenAI {
				t, b = generatePRContentCodex(ctx, cfg, prBranch)
			} else if cfg.provider == providerGemini {
				t, b = generatePRContentGemini(ctx, cfg, prBranch)
			} else if cfg.prWriter != "" {
				t, b = generatePRContent(ctx, cfg, prBranch)
			}
			if t != "" {
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

		if err := openPR(ctx, cfg, prBranch, prTitle, prBody); err != nil {
			if ctx.Err() != nil {
				log.Printf("[harness] terminated by signal")
				return nil
			}
			return fmt.Errorf("open pull request: %w", err)
		}
	}

	// ── Post-run: open an issue from the findings (issue-output mode) ───────────
	if issueOutput {
		if err := openIssue(ctx, cfg, transcript.String(), parentIssue); err != nil {
			if ctx.Err() != nil {
				log.Printf("[harness] terminated by signal")
				return nil
			}
			return fmt.Errorf("open issue: %w", err)
		}
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

// ── Codex (OpenAI) ──────────────────────────────────────────────────────────────

// withRepoPrompt layers the repo-attached system prompt (REPO_SYSTEM_PROMPT)
// onto whatever framing the harness built for a run, so a repo-wide instruction
// applies to every run regardless of mode or provider. Either side may be empty.
// It does not replace the framing — the repo prompt is appended after it.
func (c config) withRepoPrompt(sysPrompt string) string {
	if c.repoSystemPrompt == "" {
		return sysPrompt
	}
	if strings.TrimSpace(sysPrompt) == "" {
		return c.repoSystemPrompt
	}
	return sysPrompt + "\n\n" + c.repoSystemPrompt
}

// foldSystemPrompt folds the instructional framing into the prompt, for CLIs
// (Codex, Gemini) that have no `--append-system-prompt` equivalent.
func foldSystemPrompt(sysPrompt, task string) string {
	if sysPrompt == "" {
		return task
	}
	return sysPrompt + "\n\n---\n\n" + task
}

// codexArgs builds the `codex exec` argument vector. `resume` continues the
// persisted session (codex exec resume --last) for interactive follow-up turns;
// `ephemeral` skips writing session files (one-shot runs that never resume).
// Sandboxing/approvals are bypassed because the pod is already network-isolated.
func codexArgs(cfg config, prompt string, resume, ephemeral bool) []string {
	args := []string{"exec"}
	if resume {
		args = append(args, "resume", "--last")
	}
	if ephemeral {
		args = append(args, "--ephemeral")
	}
	args = append(args,
		"--model", cfg.model,
		"--json", // NDJSON events, rendered incrementally
		"--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox",
		prompt,
	)
	return args
}

// logCodexPrompt logs the system prompt and task line-by-line with the [harness]
// tag (matching the claude path) so a multi-line prompt renders as harness
// context rather than assistant output.
func logCodexPrompt(label, sysPrompt, task string) {
	if sysPrompt != "" {
		log.Printf("[harness] system prompt:")
		for _, line := range strings.Split(sysPrompt, "\n") {
			log.Printf("[harness]   %s", line)
		}
	}
	log.Printf("[harness] %s", label)
	for _, line := range strings.Split(task, "\n") {
		log.Printf("[harness]   %s", line)
	}
}

// runCodex drives the OpenAI Codex CLI for a one-shot agent pass: the whole job
// is delivered as a single prompt (the working-agreement framing prepended to the
// task) and the session is ephemeral since there's nothing to resume.
func runCodex(ctx context.Context, cfg config, prBranch string) error {
	sysPrompt := cfg.systemPrompt
	if sysPrompt == "" && prBranch != "" {
		sysPrompt = buildRepoSystemPrompt(prBranch)
	}
	sysPrompt = cfg.withRepoPrompt(sysPrompt)

	log.Printf("[harness] starting codex (model=%s)", cfg.model)
	logCodexPrompt("codex prompt:", sysPrompt, cfg.task)

	args := codexArgs(cfg, foldSystemPrompt(sysPrompt, cfg.task), false, true)
	return runCodexStreaming(ctx, cfg.workDir, buildEnv(cfg.provider), args...)
}

// runCodexInteractive drives a long-lived Codex conversation. Codex exec is
// one-shot per process, so each turn is a separate invocation: the first creates
// a session, and each follow-up resumes it (codex exec resume --last) with the
// next user message. Between turns it pauses for the user's input polled from
// Bandolier, exactly like the claude interactive loop — but the codex process
// only exists during a turn, so the blocking call itself is the turn boundary
// (no result-event signalling needed). The session must persist across turns, so
// it is NOT ephemeral. Ends on the end sentinel, idle timeout, or cancellation.
func runCodexInteractive(ctx context.Context, cfg config, first string) error {
	idle := interactiveIdleTimeout()
	env := buildEnv(cfg.provider)

	// First turn: fold the session framing into the opening message and create the
	// session (no resume, no --ephemeral so it can be resumed below). The
	// repo-attached prompt rides along on the first turn's framing.
	sysPrompt := cfg.withRepoPrompt(cfg.systemPrompt)
	logCodexPrompt("sending initial message:", sysPrompt, first)
	firstArgs := codexArgs(cfg, foldSystemPrompt(sysPrompt, first), false, false)
	if err := runCodexStreaming(ctx, cfg.workDir, env, firstArgs...); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}

	for {
		// The turn finished when the codex process exited above — wait for the
		// user's next message.
		log.Printf("[harness] %s", awaitInputMarker)
		content, ended := awaitInput(ctx, cfg, idle)
		if ended {
			log.Printf("[harness] interactive session ending")
			break
		}
		log.Printf("[harness] %s", resumeMarker)

		resumeArgs := codexArgs(cfg, content, true, false)
		if err := runCodexStreaming(ctx, cfg.workDir, env, resumeArgs...); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			log.Printf("[harness] warn: codex resume turn failed: %v", err)
			break
		}
	}
	return nil
}

// runCodexStreaming runs `codex exec --json`, rendering each NDJSON event as it
// arrives. Mirrors runClaudeStreaming but for Codex's event schema.
func runCodexStreaming(ctx context.Context, dir string, env []string, args ...string) error {
	stderr := &prefixWriter{}
	cmd := exec.CommandContext(ctx, "codex", args...)
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

	reader := bufio.NewReader(stdout)
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			handleCodexEvent(line)
		}
		if readErr != nil {
			break
		}
	}

	waitErr := cmd.Wait()
	stderr.flush()
	return waitErr
}

// codexEvent is the subset of Codex's stream-json events we render. Codex emits
// thread/turn lifecycle events plus item.started/item.completed for each action;
// the meaningful payload is on item.completed.
type codexEvent struct {
	Type string `json:"type"`
	Item *struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Command string `json:"command"`
		Query   string `json:"query"`
		Name    string `json:"name"`
	} `json:"item"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// handleCodexEvent renders one NDJSON event. The assistant's text is written to
// stdout untagged so the dashboard highlights it; everything else (tool/command
// activity and lifecycle) is tagged [harness] so it renders as dimmed context.
func handleCodexEvent(raw []byte) {
	var ev codexEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		return // ignore anything that isn't a JSON event
	}
	switch ev.Type {
	case "item.completed":
		if ev.Item == nil {
			return
		}
		switch ev.Item.Type {
		case "agent_message":
			if t := strings.TrimSpace(ev.Item.Text); t != "" {
				fmt.Fprintln(stdoutTee, t)
			}
		case "command_execution":
			if c := strings.TrimSpace(ev.Item.Command); c != "" {
				log.Printf("[harness] → exec: %s", strings.SplitN(c, "\n", 2)[0])
			}
		case "file_change":
			log.Printf("[harness] → file change")
		case "web_search":
			if q := strings.TrimSpace(ev.Item.Query); q != "" {
				log.Printf("[harness] → search: %s", q)
			}
		case "mcp_tool_call":
			if n := strings.TrimSpace(ev.Item.Name); n != "" {
				log.Printf("[harness] → tool: %s", n)
			}
		}
	case "turn.failed":
		msg := "unknown error"
		if ev.Error != nil && ev.Error.Message != "" {
			msg = ev.Error.Message
		}
		log.Printf("[harness] codex turn failed: %s", msg)
	case "turn.completed":
		log.Printf("[harness] codex turn complete")
	}
}

// ── Antigravity CLI (agy) — Gemini models ───────────────────────────────────────
//
// Gemini models run through Google's Antigravity CLI (`agy`), the successor to
// the Gemini CLI. The agent is driven non-interactively via `agy --print` (`-p`),
// a first-class headless mode that writes its response to stdout even when stdout
// isn't a terminal. agy has no structured-output flag, so callers parse the plain
// text (the writer prompt already asks for a TITLE:/BODY: format). agy
// authenticates against a Google Cloud project via Application Default
// Credentials; buildEnv materializes the credentials JSON and sets the env.

// agyArgs builds the `agy` argument vector for a one-shot, non-interactive run:
// the prompt is passed directly as the -p value (no shell, so any content is safe)
// and tool actions are auto-approved (the pod is already network-isolated).
func agyArgs(cfg config, prompt string) []string {
	return []string{"-p", prompt, "--model", cfg.model, "--dangerously-skip-permissions"}
}

// agyExec runs agy non-interactively, streaming its output to `stdout` (the
// dashboard tee when nil). stderr is tagged as harness context.
func agyExec(
	ctx context.Context,
	cfg config,
	env []string,
	prompt string,
	stdout io.Writer,
) error {
	out := stdout
	if out == nil {
		out = stdoutTee
	}
	stderr := &prefixWriter{}
	cmd := exec.CommandContext(ctx, "agy", agyArgs(cfg, prompt)...)
	cmd.Dir = cfg.workDir
	cmd.Env = env
	cmd.Stdout = out
	cmd.Stderr = stderr
	runErr := cmd.Run()
	stderr.flush()
	return runErr
}

// runGemini drives agy for a one-shot agent pass: the job is delivered as a
// single prompt (framing folded in, since agy has no system-prompt flag).
func runGemini(ctx context.Context, cfg config, prBranch string) error {
	sysPrompt := cfg.systemPrompt
	if sysPrompt == "" && prBranch != "" {
		sysPrompt = buildRepoSystemPrompt(prBranch)
	}
	sysPrompt = cfg.withRepoPrompt(sysPrompt)

	log.Printf("[harness] starting agy (model=%s)", cfg.model)
	logCodexPrompt("agy prompt:", sysPrompt, cfg.task)

	return agyExec(
		ctx,
		cfg,
		buildEnv(cfg.provider),
		foldSystemPrompt(sysPrompt, cfg.task),
		nil,
	)
}

// runGeminiInteractive drives a long-lived agy conversation. agy's headless mode
// has no stable session-resume, so continuity is maintained by replay: a running
// transcript is prepended to each turn's prompt. Workspace files persist across
// turns (same pod), so code changes accumulate; the replay carries the chat
// context. Between turns it pauses for the user's input polled from Bandolier,
// like the other interactive paths.
func runGeminiInteractive(ctx context.Context, cfg config, first string) error {
	idle := interactiveIdleTimeout()
	env := buildEnv(cfg.provider)

	sysPrompt := cfg.withRepoPrompt(cfg.systemPrompt)
	var convo strings.Builder
	if sysPrompt != "" {
		convo.WriteString(sysPrompt)
		convo.WriteString("\n\n")
	}
	convo.WriteString(
		"# Conversation\n\nContinue as the assistant using the full conversation above for context. Files you change persist between turns.\n\n",
	)

	runTurn := func(msg string) error {
		convo.WriteString("## User\n")
		convo.WriteString(msg)
		convo.WriteString("\n\n## Assistant\n")
		var buf bytes.Buffer
		// The full transcript is written to agy's prompt file, so it can grow
		// without bloating argv; capture the reply to append to the transcript.
		if err := agyExec(ctx, cfg, env, convo.String(), io.MultiWriter(stdoutTee, &buf)); err != nil {
			return err
		}
		convo.WriteString(strings.TrimSpace(buf.String()))
		convo.WriteString("\n\n")
		return nil
	}

	logCodexPrompt("sending initial message:", sysPrompt, first)
	if err := runTurn(first); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}

	for {
		log.Printf("[harness] %s", awaitInputMarker)
		content, ended := awaitInput(ctx, cfg, idle)
		if ended {
			log.Printf("[harness] interactive session ending")
			break
		}
		log.Printf("[harness] %s", resumeMarker)
		if err := runTurn(content); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			log.Printf("[harness] warn: agy turn failed: %v", err)
			break
		}
	}
	return nil
}

// generatePRContentGemini is the agy equivalent of generatePRContent: a cheap
// same-provider writer (PR_WRITER_MODEL, the latest Flash, falling back to the
// task model) writes the PR copy. Returns ("", "") on any failure.
func generatePRContentGemini(ctx context.Context, cfg config, branchName string) (string, string) {
	return generateWriterContentGemini(ctx, cfg, buildPRPrompt(ctx, cfg, branchName))
}

// generateWriterContentGemini is the agy equivalent of generateWriterContent: a
// cheap same-provider writer turns a TITLE/BODY prompt into copy. agy has no
// structured-output mode, so the plain-text reply is parsed directly.
func generateWriterContentGemini(ctx context.Context, cfg config, prompt string) (string, string) {
	writerModel := cfg.prWriter
	if writerModel == "" {
		writerModel = cfg.model
	}

	genCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	log.Printf("[harness] writing PR title/description with agy (%s)", writerModel)
	// Run the writer model via a config override; capture stdout to parse.
	writerCfg := cfg
	writerCfg.model = writerModel
	var buf bytes.Buffer
	if err := agyExec(genCtx, writerCfg, buildEnv(cfg.provider), prompt, &buf); err != nil {
		log.Printf("[harness] warn: agy PR copy generation failed: %v", err)
		return "", ""
	}
	return parsePRContent(buf.String())
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

// userInputMarker tags lines in the transcript that carry a user's interactive
// message, so the dashboard can render them as chat history distinct from
// harness diagnostics ([harness]) and Claude's responses (untagged). Each line
// of a message is tagged so multi-line input stays grouped and a stray newline
// can't make part of it render as Claude output.
const userInputMarker = "[user]"

// logUserInput records a user's interactive message into the transcript. It goes
// through the log package (like [harness] lines) so it's mirrored into the
// persisted transcript and picked up by the dashboard's live log poll.
func logUserInput(text string) {
	for _, line := range strings.Split(text, "\n") {
		log.Printf("%s %s", userInputMarker, line)
	}
}

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

// interactiveFraming picks the interactive system prompt for the run: the
// issue-output framing (analysis, no commits) when producing an issue, otherwise
// the default commit-as-you-go framing tied to the working branch.
func interactiveFraming(issueOutput bool, branchName string) string {
	if issueOutput {
		return buildIssueOutputInteractivePrompt()
	}
	return buildInteractiveSystemPrompt(branchName)
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
	sysPrompt := cfg.withRepoPrompt(cfg.systemPrompt)
	if sysPrompt != "" {
		args = append(args, "--append-system-prompt", sysPrompt)
	}
	// Log the system prompt line-by-line so each line keeps the [harness] tag
	// (matching the non-interactive claude path and logCodexPrompt). Without this
	// the repo-attached system prompt never appears in the harness logs.
	if sysPrompt != "" {
		log.Printf("[harness] system prompt:")
		for _, line := range strings.Split(sysPrompt, "\n") {
			log.Printf("[harness]   %s", line)
		}
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

	// Record the seed prompt as user input so it opens the rendered chat history
	// the same way follow-up messages do (the dashboard renders [user] lines as
	// the user's turns, distinct from harness diagnostics and Claude's output).
	logUserInput(first)
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
		// Record the message so it appears in the rendered chat history as the
		// user's turn, sitting between Claude's responses.
		logUserInput(content)
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
