package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

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

func repoBranchName(title string) string {
	return fmt.Sprintf("bandolier/%s-%s", slugify(title), shortUnique())
}

// buildRepoSystemPrompt is the instructional framing for a freeform dashboard
// task: the working agreement that lets the harness reliably open a PR. It is
// appended to Claude's system prompt; the user's task stays the user message.
func buildRepoSystemPrompt(branchName string) string {
	return fmt.Sprintf(`## Working agreement

The repository has been cloned. You are on branch "%s" — do not switch branches.

When you have completed the task in the user message, commit your work:
1. Split the change into a sequence of small, self-contained commits — one coherent step per commit, ordered so each builds on the last and, where practical, leaves the tree working — so a reviewer can read it commit-by-commit. Prefer several focused commits over one large squashed commit; a genuinely small change can be a single commit.
2. Leave nothing uncommitted, and sign off every commit:
   git add -A
   git commit -s -m "<concise summary of the step>"

Do NOT push or open a pull request — the harness will do that once you finish.
Do not ask for clarification. Implement the best solution you can.`,
		branchName)
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

// ── Git plumbing ──────────────────────────────────────────────────────────────

// ensureDiffBase guarantees the ref this run's work is diffed against
// (cfg.diffBase()) resolves in the clone. The pod clones with --depth=1, which
// implies --single-branch: only the checked-out branch's remote ref exists. If
// the run then diffs against a different branch (a stale or misconfigured
// server↔harness pairing has landed here before), every range downstream —
// hasCommits, the authorship rewrite, the PR-writer's log and diff — dies on
// an "unknown revision". Fetch the missing ref explicitly (the single-branch
// fetch refspec would never map it), and fail with a diagnosable error when
// the remote can't provide it either.
func ensureDiffBase(ctx context.Context, cfg config) error {
	base := cfg.diffBase()
	if _, err := captureCmd(ctx, cfg.workDir, "git", "rev-parse", "--verify", "--quiet", base+"^{commit}"); err == nil {
		return nil
	}
	branch := strings.TrimPrefix(base, "origin/")
	log.Printf("[harness] diff base %s missing from the clone — fetching it", base)
	if err := runCmd(ctx, cfg.workDir, os.Environ(), "git", "fetch", "--depth=1", "origin",
		fmt.Sprintf("+refs/heads/%s:refs/remotes/origin/%s", branch, branch)); err != nil {
		return fmt.Errorf("diff base %s is not in the clone and fetching it failed: %w", base, err)
	}
	return nil
}

// hasCommits reports whether branchName carries commits of this run's own —
// beyond the PR base, or (on a resume) beyond what the branch had already
// pushed — i.e. whether Claude actually committed anything worth publishing.
func hasCommits(ctx context.Context, cfg config, branchName string) bool {
	cmd := exec.CommandContext(ctx, "git", "rev-list", "--count",
		fmt.Sprintf("%s..%s", cfg.diffBase(), branchName))
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
	// Scoped to this run's own commits (diffBase): on a resume the branch's
	// already-pushed history must not be rewritten, or the push becomes a
	// rejected non-fast-forward.
	rangeSpec := fmt.Sprintf("%s..%s", cfg.diffBase(), branchName)
	return runCmd(ctx, cfg.workDir, env, "git", "filter-branch", "-f",
		"--env-filter", envFilter,
		"--msg-filter", msgFilter,
		"--", rangeSpec)
}

// ── PR / issue creation ───────────────────────────────────────────────────────

var prURLRe = regexp.MustCompile(`https://github\.com/\S+/pull/\d+`)

var issueURLRe = regexp.MustCompile(`https://github\.com/\S+/issues/\d+`)

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
	res := classifyPRCreate(out, err)
	if res.err != nil {
		return res.err
	}
	if res.alreadyExists {
		log.Printf("[harness] pull request already exists for %s", branchName)
	}

	// Emit the PR URL with a stable marker so the dashboard can surface it, and
	// record it for the ingest callback so it outlives the pod logs.
	if res.url != "" {
		outputPRURL = res.url
		log.Printf("[harness] PR_URL=%s", res.url)
	} else {
		log.Printf("[harness] pull request created (no URL parsed)")
	}
	return nil
}

// prCreateResult is the decision classifyPRCreate derives from a `gh pr create`
// invocation: the scraped PR URL, whether the failure was an idempotent
// "already exists", and the error to propagate for a genuine failure.
type prCreateResult struct {
	url           string
	alreadyExists bool
	err           error
}

// classifyPRCreate turns the combined output and exit error of `gh pr create`
// into a decision. gh exits non-zero when a PR for this branch already exists —
// that's idempotent success. Any other failure (auth, rate limit, branch
// protection) is propagated so the run doesn't report a false success. The PR
// URL is scraped regardless, since gh prints it on both the created and the
// already-exists paths.
func classifyPRCreate(out string, err error) prCreateResult {
	res := prCreateResult{url: prURLRe.FindString(out)}
	if err != nil {
		if strings.Contains(strings.ToLower(out), "already exists") {
			res.alreadyExists = true
		} else {
			res.err = fmt.Errorf("gh pr create: %w", err)
		}
	}
	return res
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

	title, body := generateWriterContent(ctx, cfg, buildIssuePrompt(transcript, parent))
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
