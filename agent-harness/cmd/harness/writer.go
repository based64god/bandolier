package main

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// ── Out-of-band writer copy (PR title/description, issue title/body) ──────────
//
// PR and issue copy is written by a cheap out-of-band writer model — the latest
// Sonnet/GPT-mini/Flash (PR_WRITER_MODEL), falling back to the task model —
// independent of the model that performed the task. Every provider runs the
// writer through the claude CLI; non-Anthropic writer models resolve through
// the embedded model proxy like the task model does.

// maxPRDiffBytes caps how much of the diff is sent to the PR-writer model, to
// keep the prompt within a reasonable size on large changes.
const maxPRDiffBytes = 60_000

// maxIssueTranscriptBytes caps how much of the run transcript is sent to the
// issue-writer model. The agent's write-up lands at the end, so we keep the tail.
const maxIssueTranscriptBytes = 60_000

// largeDiffFiles and largeDiffLines set when a change is big enough that the PR
// description should lead with a commit-by-commit review guide rather than hand
// a reviewer one undifferentiated diff. They mirror the widely-cited
// reviewability guidance that smaller PRs are reviewed faster and with fewer
// defects; either threshold trips the guide.
const (
	largeDiffFiles = 15
	largeDiffLines = 400
)

// diffSummary is the size of a branch's change — files touched and lines added
// and removed — as reported by `git diff --numstat`.
type diffSummary struct {
	files   int
	added   int
	deleted int
}

func (d diffSummary) lines() int { return d.added + d.deleted }

// large reports whether the change is big enough to warrant a review guide.
func (d diffSummary) large() bool {
	return d.files >= largeDiffFiles || d.lines() >= largeDiffLines
}

// summarizeNumstat parses `git diff --numstat` output into a diffSummary. Each
// line is "<added>\t<deleted>\t<path>"; binary files report "-" for the counts,
// contributing a changed file but no lines.
func summarizeNumstat(numstat string) diffSummary {
	var d diffSummary
	for _, line := range strings.Split(strings.TrimSpace(numstat), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		d.files++
		if n, err := strconv.Atoi(fields[0]); err == nil {
			d.added += n
		}
		if n, err := strconv.Atoi(fields[1]); err == nil {
			d.deleted += n
		}
	}
	return d
}

// buildPRPrompt assembles the instruction + commits/diff context the PR-writer
// model turns into a title and description. Shared by every provider's writer so
// they all produce identical copy from the same inputs.
func buildPRPrompt(ctx context.Context, cfg config, branchName string) string {
	// The commit list is the symmetric "reachable from branch but not base"
	// (two-dot) range — exactly the commits this branch adds.
	logRange := fmt.Sprintf("%s..%s", cfg.diffBase(), branchName)
	gitLog, _ := captureCmd(ctx, cfg.workDir, "git", "log", logRange, "--pretty=format:- %s%n%b")

	// The diff and diffstat use a three-dot range so they are computed against
	// the merge-base of the base and working branches, not the base branch tip.
	// A two-dot `git diff` compares the tips directly, so if the base branch has
	// moved on since this branch forked (e.g. the agent fetched/pulled during the
	// run), unrelated base-only commits leak in as spurious reversed changes and
	// can swamp or truncate the real changes — which is what made PR copy
	// generation sometimes fail. The three-dot form diffs only what this branch
	// introduced relative to where it diverged.
	diffRange := fmt.Sprintf("%s...%s", cfg.diffBase(), branchName)
	diffstat, _ := captureCmd(ctx, cfg.workDir, "git", "diff", "--stat", diffRange)
	// numstat is parsed for size gating; it is computed over the full change even
	// when the diff text below is truncated, so a huge change is still detected.
	numstat, _ := captureCmd(ctx, cfg.workDir, "git", "diff", "--numstat", diffRange)
	diff, _ := captureCmd(ctx, cfg.workDir, "git", "diff", diffRange)
	if len(diff) > maxPRDiffBytes {
		diff = diff[:maxPRDiffBytes] + "\n…(diff truncated)…"
	}

	return renderPRPrompt(gitLog, diffstat, diff, summarizeNumstat(numstat))
}

// renderPRPrompt formats the PR-writer instruction from the gathered git
// context. When the change is large, the writer is asked to lead the body with a
// "## Suggested review order" walkthrough so the diff can be reviewed in small
// pieces. Kept separate from the git plumbing so it is unit-testable.
func renderPRPrompt(gitLog, diffstat, diff string, summary diffSummary) string {
	bodyGuidance := `<markdown description: a one or two sentence summary, then a "## Changes" section with a bullet list of the notable changes>`
	reviewGuidance := ""
	if summary.large() {
		reviewGuidance = fmt.Sprintf("\nThis is a large change (%d files changed, ~%d lines) — make it reviewable in small pieces. In the BODY, right after the summary and before \"## Changes\", add a \"## Suggested review order\" section: a numbered walkthrough that breaks the change into small logical steps a reviewer can check one at a time (follow the commits when there are several, otherwise group by area or file). Keep the \"## Changes\" section as well.\n", summary.files, summary.lines())
	}

	return fmt.Sprintf(`Write a GitHub pull request title and description for the changes below, based ONLY on what the commits and diff actually show. Be accurate and concise; do not invent changes or mention the task prompt.
%s
Respond in EXACTLY this format, with no preamble and no code fences:
TITLE: <single-line imperative title, ~70 chars max>
BODY:
%s

=== COMMITS ===
%s

=== DIFFSTAT ===
%s

=== DIFF ===
%s`, reviewGuidance, bodyGuidance, strings.TrimSpace(gitLog), strings.TrimSpace(diffstat), diff)
}

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

// generatePRContent writes a PR title and description from the branch's commits
// via the out-of-band writer. Returns ("", "") on any failure so the caller
// keeps its baseline title/body.
func generatePRContent(ctx context.Context, cfg config, branchName string) (string, string) {
	return generateWriterContent(ctx, cfg, buildPRPrompt(ctx, cfg, branchName))
}

// generateWriterContent runs the run's out-of-band writer model on a TITLE/BODY
// prompt — shared by the PR-copy and issue-copy writers across all providers. It
// owns the timeout, the writer-model fallback, and TITLE/BODY parsing; the raw
// CLI invocation is delegated to the provider's writerExecFn. Returns ("", "")
// on any failure so callers keep their baseline copy.
func generateWriterContent(ctx context.Context, cfg config, prompt string) (string, string) {
	writerModel := cfg.prWriter
	if writerModel == "" {
		writerModel = cfg.model
	}

	// Bound the call so a slow or hung model never blocks the run indefinitely.
	genCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	log.Printf("[harness] writing title/description with %s (%s)", writerModel, cfg.provider)
	out, err := writerExecClaude(genCtx, cfg, writerModel, prompt)
	if err != nil {
		log.Printf("[harness] warn: copy generation failed: %v", err)
		return "", ""
	}
	return parsePRContent(out)
}

// writerExecClaude runs the writer model via the claude CLI.
func writerExecClaude(ctx context.Context, cfg config, writerModel, prompt string) (string, error) {
	return captureCmdEnv(ctx, cfg.workDir, buildEnv(cfg.provider),
		"claude", "--print",
		"--model", writerModel,
		"--max-turns", "1",
		"--dangerously-skip-permissions",
		prompt)
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
