package main

import (
	"fmt"
	"os"
	"strings"
)

// ── Reasoning effort ────────────────────────────────────────────────────────

// effortLevels are the values the `claude` CLI accepts for --effort. This
// allow-list crosses to the dashboard/webhook side, so its values are pinned in
// wire-contract.json and asserted by both test suites (see
// wire_contract_test.go). Effort is a Claude-only control; the Codex and
// Antigravity CLIs don't take it.
var effortLevels = map[string]bool{
	"low":    true,
	"medium": true,
	"high":   true,
	"xhigh":  true,
	"max":    true,
}

// normalizeEffort lower-cases and validates a requested effort level, returning
// "" for anything unrecognized so callers fall back to the CLI default rather
// than passing an invalid flag.
func normalizeEffort(s string) string {
	v := strings.ToLower(strings.TrimSpace(s))
	if effortLevels[v] {
		return v
	}
	return ""
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
	effort           string // reasoning-effort level for the claude CLI (--effort); Claude providers only
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
	acpURL           string // Bandolier ACP relay endpoint the proxy pulls/pushes frames on
	outputType       string // "pr" (default) or "issue": what the run produces when done
	// resumeBranch is the existing remote branch this run resumes work on
	// (RESUME_BRANCH): the server clones it directly (BRANCH is set to the same
	// value), no fresh branch is cut, new work is measured against its remote tip
	// rather than the PR base, and pushed commits land on the parent run's open
	// PR. Empty = a normal run.
	resumeBranch string
	// contextURL is the Bandolier endpoint serving the parent run's persisted
	// transcript (BANDOLIER_CONTEXT_URL); set only for resumed runs. The harness
	// fetches it before starting and folds it into the task as context.
	contextURL string
	// serenaPrompt is Serena's Claude-Code system-prompt override
	// (`serena prompts print-cc-system-prompt-override`), populated once per run
	// for Claude providers by setupSerena and appended to whatever framing the
	// harness builds. It steers Claude toward Serena's semantic code-navigation
	// tools over the built-in file tools. Empty for non-Claude providers.
	serenaPrompt string
}

// resuming reports whether this run continues an existing branch (and PR)
// rather than cutting a fresh one.
func (c config) resuming() bool { return c.resumeBranch != "" }

// diffBase is the ref this run's own work is measured against: the resumed
// branch's remote tip (everything already pushed, by the parent run or anyone
// else) when resuming, else the PR base branch. Scoping to the remote tip on a
// resume keeps commit-author rewriting and PR-copy generation off commits that
// are already published — rewriting those would diverge from origin and turn
// the push into a rejected non-fast-forward.
func (c config) diffBase() string {
	if c.resuming() {
		return "origin/" + c.resumeBranch
	}
	return "origin/" + c.baseBranch
}

// issueOutput reports whether the run should produce a GitHub issue instead of a
// pull request: the agent analyses the task/repo (no branch, no commits) and the
// harness opens an issue written from the transcript by the writer model.
func (c config) issueOutput() bool { return c.outputType == "issue" }

// claudeProvider reports whether the run drives the `claude` CLI (Anthropic API
// or AWS Bedrock), as opposed to Codex (OpenAI) or Antigravity (Gemini). Serena
// is wired for all three, but the Claude path additionally applies a Claude-Code
// system-prompt override that the other CLIs don't take.
func (c config) claudeProvider() bool {
	return c.provider == providerAnthropic || c.provider == providerBedrock
}

// writesPRCopy reports whether the post-run step generates out-of-band PR copy
// for this run. Codex and Gemini always use a cheap same-provider writer; a
// Claude run only does so when a dedicated writer model (PR_WRITER_MODEL) is
// configured, rather than spending the task model on it.
func (c config) writesPRCopy() bool {
	return c.provider == providerOpenAI || c.provider == providerGemini || c.prWriter != ""
}

// withRepoPrompt layers the repo-attached system prompt (REPO_SYSTEM_PROMPT)
// and, for Claude runs, Serena's Claude-Code system-prompt override onto
// whatever framing the harness built for a run, so a repo-wide instruction and
// the Serena tool-preference steer apply to every run regardless of mode. Any
// side may be empty. It does not replace the framing — each layer is appended
// after it, repo prompt first then the Serena override.
func (c config) withRepoPrompt(sysPrompt string) string {
	parts := make([]string, 0, 3)
	for _, p := range []string{sysPrompt, c.repoSystemPrompt, c.serenaPrompt} {
		if strings.TrimSpace(p) != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, "\n\n")
}

// foldSystemPrompt folds the instructional framing into the prompt, for CLIs
// (Codex, Gemini) that have no `--append-system-prompt` equivalent.
func foldSystemPrompt(sysPrompt, task string) string {
	if sysPrompt == "" {
		return task
	}
	return sysPrompt + "\n\n---\n\n" + task
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

	// Reasoning effort for the claude CLI (--effort). Validate against the known
	// levels and drop an unknown value so a bad input never breaks the run — the
	// CLI then uses its own default.
	effort := normalizeEffort(os.Getenv("CLAUDE_EFFORT"))

	// Turns are unlimited by default (JavaScript's Number.MAX_SAFE_INTEGER,
	// matching the server's DEFAULT_MAX_TURNS); the Job's MAX_TURNS overrides.
	maxTurns := os.Getenv("MAX_TURNS")
	if maxTurns == "" {
		maxTurns = "9007199254740991"
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
		effort:           effort,
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
		acpURL:           os.Getenv("BANDOLIER_ACP_URL"),
		outputType:       outputType,
		resumeBranch:     strings.TrimSpace(os.Getenv("RESUME_BRANCH")),
		contextURL:       os.Getenv("BANDOLIER_CONTEXT_URL"),
	}, nil
}
