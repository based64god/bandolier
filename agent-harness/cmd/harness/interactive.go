package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"
)

// ── Interactive mode ────────────────────────────────────────────────────────────

// endSessionSentinel is the input message that ends an interactive session.
// This value crosses to the server, so it's pinned in wire-contract.json and
// asserted by both test suites (see wire_contract_test.go).
const endSessionSentinel = "__BANDOLIER_END_SESSION__"

// Log markers the dashboard parses to know whether an interactive agent is
// currently waiting for the user. These values cross to the server, so they're
// pinned in wire-contract.json and asserted by both test suites (see
// wire_contract_test.go).
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
	return fmt.Sprintf(`This is an interactive session: the user will keep sending follow-up messages, so do not assume you must finish everything in one turn. The repository is cloned and you are on branch %q — do not switch branches. Commit changes as we go in small, self-contained steps (git add -A && git commit) so the work stays reviewable commit-by-commit. When the session ends, the harness pushes the branch and opens a pull request if there are commits.`, branchName)
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

// awaitInput polls Bandolier for the next user message. It returns ended=true on
// the end sentinel, the idle timeout, or context cancellation.
func awaitInput(ctx context.Context, cfg config, idle time.Duration) (string, bool) {
	var content string
	var got bool
	pollLoop(ctx, "input", idle, func(ctx context.Context) (bool, bool) {
		msg, ok, err := pollInput(ctx, cfg)
		if err != nil {
			log.Printf("[harness] warn: input poll failed: %v", err)
			return false, false
		}
		if !ok {
			return false, false
		}
		if msg == endSessionSentinel {
			return false, true
		}
		content, got = msg, true
		return true, true
	})
	return content, !got
}

// pollInput fetches the next queued user message from Bandolier, returning
// ok=false when the queue is empty (HTTP 204).
func pollInput(ctx context.Context, cfg config) (string, bool, error) {
	if cfg.inputURL == "" {
		return "", false, fmt.Errorf("no input URL configured")
	}
	var body struct {
		Content string `json:"content"`
	}
	ok, err := bando.getJSON(ctx, "input poll", cfg.inputURL, &body)
	if err != nil || !ok {
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
