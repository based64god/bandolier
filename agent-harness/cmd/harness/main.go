// harness bootstraps a Claude Code agent inside a Kubernetes pod.
// It reads task configuration from environment variables, optionally clones
// a git repository, then runs `claude --print` non-interactively and exits
// with the same exit code so the Job's success/failure is recorded correctly.
//
// When GITHUB_ISSUE_NUMBER is set the harness enters "issue mode":
//   - It fetches the issue via `gh issue view` to build a structured task prompt
//   - It creates a dedicated git branch (issue-N/title-slug)
//   - After Claude finishes it pushes the branch and opens a PR that closes the issue
//
// main.go owns the run lifecycle: setupGit → resolveMode → runAgent → finish.
// The provider drivers, GitHub plumbing, config, transcript capture, Serena
// setup, and interactive loop live in sibling files within this package.
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// ── Core logic ────────────────────────────────────────────────────────────────

// runMode is the resolved plan for a run: whether it opens a PR (on prBranch,
// when non-empty) or an issue (issueOutput), the baseline PR copy, and the
// originating issue when the run was triggered by one. resolveMode computes it
// from the config and the environment up front, rather than mutating cfg in
// place across a switch.
type runMode struct {
	prBranch    string
	prTitle     string
	prBody      string
	issueOutput bool
	parentIssue *githubIssue // the originating issue, when triggered by one
}

// orSignal maps a driver/step error to the run's result: a nil error when the
// context was cancelled (the pod received SIGTERM, so a clean shutdown), or the
// error wrapped with op otherwise. It replaces the signal-check block that was
// copy-pasted after every fallible step in run().
func orSignal(ctx context.Context, err error, op string) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		log.Printf("[harness] terminated by signal")
		return errSignaled
	}
	return fmt.Errorf("%s: %w", op, err)
}

// errSignaled is the sentinel orSignal returns when the run was cancelled by a
// signal: run() treats it as a clean stop (no error) but must not proceed to the
// post-run steps, so it short-circuits without being reported as a failure.
var errSignaled = fmt.Errorf("terminated by signal")

func run(ctx context.Context, cfg config) error {
	if err := os.MkdirAll(cfg.workDir, 0o755); err != nil {
		return fmt.Errorf("create working directory: %w", err)
	}
	logProvider(cfg)

	// Non-Anthropic providers are served through the embedded gollm proxy: it
	// speaks the Anthropic Messages API on localhost and translates to the
	// run's real backend, so the claude CLI drives every provider. Started
	// before any claude invocation (agent, writer model, acp-agent child) and
	// kept up for the whole run.
	if needsModelProxy(cfg.provider) {
		stopProxy, err := startModelProxy(cfg)
		if err != nil {
			return fmt.Errorf("start model proxy: %w", err)
		}
		defer stopProxy()
	}

	name, email := gitIdentity(cfg)
	if err := setupGit(ctx, cfg, name, email); err != nil {
		return err
	}

	// Serena is part of the default harness: register its MCP server against the
	// working tree for the active provider's CLI (and, for Claude, capture its
	// Claude-Code system-prompt override). Done after the clone so the MCP server
	// binds to the repo. Best effort — a failure here leaves Serena off but never
	// blocks the run.
	setupSerena(ctx, &cfg)

	// Resumed runs start with the parent run's transcript folded into the task,
	// so the agent carries the full context of the run it continues.
	if cfg.contextURL != "" {
		if parentContext := fetchParentContext(ctx, cfg); parentContext != "" {
			log.Printf("[harness] resuming with parent context (%d bytes)", len(parentContext))
			cfg.task = withParentContext(cfg.task, parentContext)
		}
	}

	mode, err := resolveMode(ctx, &cfg)
	if err != nil {
		return err
	}

	// Create and switch to the working branch for PR-producing modes. A resumed
	// run cloned the working branch directly (BRANCH == the resumed branch), so
	// it's already checked out — cutting it again would fail.
	if mode.prBranch != "" && mode.prBranch != cfg.branch {
		log.Printf("[harness] creating branch %s", mode.prBranch)
		if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", "checkout", "-b", mode.prBranch); err != nil {
			return fmt.Errorf("git checkout -b %s: %w", mode.prBranch, err)
		}
	}

	if err := runAgent(ctx, cfg, mode); err != nil {
		if err == errSignaled {
			return nil
		}
		return err
	}

	if err := finish(ctx, cfg, mode, name, email); err != nil {
		if err == errSignaled {
			return nil
		}
		return err
	}

	log.Printf("[harness] task complete")
	return nil
}

// gitIdentity resolves the git author identity for the run, falling back to the
// Bandolier agent identity when the server didn't inject one.
func gitIdentity(cfg config) (name, email string) {
	name = cfg.gitName
	if name == "" {
		name = "Bandolier Agent"
	}
	email = cfg.gitEmail
	if email == "" {
		email = "bandolier-agent@bandolier.local"
	}
	return name, email
}

// setupGit configures the git identity and DCO sign-off hook, wires the GitHub
// token into a credential helper, and clones the repository when one is
// configured — everything the agent needs before it starts committing.
func setupGit(ctx context.Context, cfg config, name, email string) error {
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
	return nil
}

// resolveMode determines the working mode from the run's trigger (issue, repo,
// or plain) and returns the resulting plan. It sets cfg.task and cfg.systemPrompt
// where they need to be built (issue context, working-agreement framing) but no
// longer threads that state through an in-place mutation of a shared switch.
func resolveMode(ctx context.Context, cfg *config) (runMode, error) {
	mode := runMode{issueOutput: cfg.issueOutput()}

	switch {
	case cfg.issueNumber != "":
		// ── Issue-triggered ──────────────────────────────────────────────────────
		log.Printf("[harness] issue mode: #%s (output=%s)", cfg.issueNumber, cfg.outputType)
		issue, err := fetchIssue(ctx, cfg.workDir, cfg.issueNumber)
		if err != nil {
			return runMode{}, fmt.Errorf("fetch issue: %w", err)
		}
		log.Printf("[harness] issue #%d: %s", issue.Number, issue.Title)
		mode.parentIssue = issue

		// The server is the single source of truth for the issue prompt: it always
		// passes the issue context as CLAUDE_TASK. Fail loudly if it's missing
		// rather than silently rebuilding a divergent copy here.
		if strings.TrimSpace(cfg.task) == "" {
			return runMode{}, fmt.Errorf("issue mode: CLAUDE_TASK is empty (the server must supply the issue context)")
		}
		if mode.issueOutput {
			// Produce a sub-task issue from the parent: no branch, analysis framing.
			if cfg.systemPrompt == "" {
				cfg.systemPrompt = buildIssueOutputSystemPrompt(issue)
			}
		} else {
			// Produce a PR that closes the issue. The server generates the unique
			// working branch and the instructional framing and passes both; require
			// them rather than reconstructing a copy that could drift.
			mode.prBranch = cfg.agentBranch
			if mode.prBranch == "" {
				return runMode{}, fmt.Errorf("issue mode: AGENT_BRANCH is empty (the server must supply the working branch)")
			}
			if strings.TrimSpace(cfg.systemPrompt) == "" {
				return runMode{}, fmt.Errorf("issue mode: CLAUDE_SYSTEM_PROMPT is empty (the server must supply the framing)")
			}
			mode.prTitle = issue.Title
			mode.prBody = fmt.Sprintf("Closes #%d\n\nGenerated by Bandolier.", issue.Number)
		}

	case cfg.repoURL != "":
		// ── Repo mode (dashboard deploy against a repository) ────────────────────
		log.Printf("[harness] repo mode (output=%s)", cfg.outputType)
		if mode.issueOutput {
			// Analysis-only; the harness opens an issue from the findings. The
			// interactive path is framed in runAgent.
			if !cfg.interactive {
				cfg.systemPrompt = buildIssueOutputSystemPrompt(nil)
			}
		} else if cfg.resuming() {
			// Resume an existing branch (and its open PR): the clone already landed
			// on it, and the server framed the run (system prompt + task), so keep
			// that framing and only fall back to the default if it's missing.
			mode.prBranch = cfg.resumeBranch
			mode.prTitle = "Bandolier agent changes"
			mode.prBody = "Generated by Bandolier."
			if !cfg.interactive && cfg.systemPrompt == "" {
				cfg.systemPrompt = buildRepoSystemPrompt(mode.prBranch)
			}
		} else {
			branchLabel := cfg.title
			if branchLabel == "" {
				branchLabel = "task"
			}
			mode.prBranch = repoBranchName(branchLabel)
			// Placeholder title; replaced with the commit summary after Claude runs.
			mode.prTitle = "Bandolier agent changes"
			mode.prBody = "Generated by Bandolier."
			// Interactive sessions are framed in runAgent (the user drives commits
			// over many turns); only one-shot repo tasks get the commit-and-finish
			// working agreement, kept out of the user message as a system prompt.
			if !cfg.interactive {
				cfg.systemPrompt = buildRepoSystemPrompt(mode.prBranch)
			}
		}

	default:
		log.Printf("[harness] plain mode (no repository)")
	}

	return mode, nil
}

// runAgent dispatches to the provider's driver for the run's mode
// (interactive vs one-shot), returning errSignaled when the context was
// cancelled so run() can stop cleanly without reporting a failure.
func runAgent(ctx context.Context, cfg config, mode runMode) error {
	// Frame an interactive session for non-issue runs (issue mode already set its
	// own system prompt in resolveMode); the framing goes in the system prompt so
	// the user's messages stay unadorned.
	if cfg.interactive && cfg.issueNumber == "" {
		cfg.systemPrompt = interactiveFraming(mode.issueOutput, mode.prBranch)
	}

	// Every provider is driven through the claude CLI — non-Anthropic backends
	// sit behind the embedded model proxy (see modelproxy.go).
	if cfg.interactive {
		// Interactive session: drive Claude over streaming JSON and pause for the
		// user's next message between turns.
		return orSignal(ctx, runACPProxy(ctx, cfg), "claude")
	}
	return orSignal(ctx, runClaude(ctx, cfg), "claude")
}

// finish runs the post-run steps for the resolved mode: rewriting commit
// authorship and opening a PR (PR modes), or opening a GitHub issue from the
// transcript (issue-output mode). It returns errSignaled on cancellation.
func finish(ctx context.Context, cfg config, mode runMode, name, email string) error {
	// ── Post-run: push branch and open PR ──────────────────────────────────────
	if mode.prBranch != "" {
		// Everything below diffs against cfg.diffBase() (hasCommits, the
		// authorship rewrite, the PR-writer's log and diff), but the --depth=1
		// clone is single-branch and may not hold that ref. Self-heal by
		// fetching it — or fail here with a clear message instead of letting
		// filter-branch die on an "unknown revision".
		if err := orSignal(ctx, ensureDiffBase(ctx, cfg), "ensure diff base"); err != nil {
			return err
		}

		// Rewrite authorship to the GitHub OAuth identity (and strip Claude/AI
		// co-author trailers) before anything is pushed, so commits are attributed
		// solely to the acting user. Done first so the commit subject and generated
		// PR copy below reflect the rewritten commits.
		if err := orSignal(ctx, rewriteCommitAuthors(ctx, cfg, mode.prBranch, name, email), "rewrite commit authors"); err != nil {
			return err
		}

		// Baseline title: for dashboard (non-issue) PRs use Claude's commit summary
		// rather than the prompt; issue PRs keep the issue title.
		if cfg.issueNumber == "" {
			if subject := latestCommitSubject(ctx, cfg, mode.prBranch); subject != "" {
				mode.prTitle = subject
			}
		}

		// Out-of-band PR copy written from the actual commits, independent of the
		// task model (see writer.go). On any failure this leaves the baseline
		// title/body untouched.
		if cfg.writesPRCopy() && hasCommits(ctx, cfg, mode.prBranch) {
			if t, b := generatePRContent(ctx, cfg, mode.prBranch); t != "" {
				mode.prTitle = t
				if strings.TrimSpace(b) != "" {
					mode.prBody = b
				}
			}
		}

		// Always preserve the issue-closing trailer so a merged issue PR closes it,
		// even when the body was rewritten above.
		if cfg.issueNumber != "" {
			mode.prBody = ensureCloses(mode.prBody, cfg.issueNumber)
		}

		if err := orSignal(ctx, openPR(ctx, cfg, mode.prBranch, mode.prTitle, mode.prBody), "open pull request"); err != nil {
			return err
		}
	}

	// ── Post-run: open an issue from the findings (issue-output mode) ───────────
	if mode.issueOutput {
		if err := orSignal(ctx, openIssue(ctx, cfg, transcript.String(), mode.parentIssue), "open issue"); err != nil {
			return err
		}
	}

	return nil
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	// `harness acp-agent` runs the ACP agent server: it speaks JSON-RPC on
	// stdin/stdout, so it must claim the process before the normal harness
	// logging setup tees diagnostics onto stdout.
	if len(os.Args) > 1 && os.Args[1] == "acp-agent" {
		if err := runACPAgent(); err != nil {
			log.Fatalf("acp-agent: %v", err)
		}
		return
	}

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
	uploadTranscript(runErr != nil)
	if runErr != nil {
		log.Fatalf("[harness] error: %v", runErr)
	}
}
