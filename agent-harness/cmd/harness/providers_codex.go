package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strings"
)

// ── Codex (OpenAI) ──────────────────────────────────────────────────────────────
//
// Codex emits thread/turn lifecycle events plus item.started/item.completed for
// each action; the meaningful payload is on item.completed. As with Claude, the
// wire format is parsed once (dispatchCodexEvent) into normalized callbacks so
// the one-shot log path and the ACP driver can't drift on their interpretation.

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
// tag (shared with the claude path) so a multi-line prompt renders as harness
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

	forEachLine(stdout, handleCodexEvent)

	waitErr := cmd.Wait()
	stderr.flush()
	return waitErr
}

// codexEvent is the subset of Codex's stream-json events we render.
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

// codexEventSink receives the normalized events dispatchCodexEvent extracts from
// one NDJSON line. As with the Claude sink, rendering is the sink's concern; the
// parser only classifies.
type codexEventSink interface {
	onMessage(text string)
	onCommand(command string)
	onFileChange()
	onWebSearch(query string)
	onMCPToolCall(name string)
	onTurnFailed(msg string)
	onTurnCompleted()
}

// dispatchCodexEvent parses one NDJSON line and drives the sink. Anything that
// isn't a recognized JSON event is ignored.
func dispatchCodexEvent(raw []byte, sink codexEventSink) {
	var ev codexEvent
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	switch ev.Type {
	case "item.completed":
		if ev.Item == nil {
			return
		}
		switch ev.Item.Type {
		case "agent_message":
			if t := strings.TrimSpace(ev.Item.Text); t != "" {
				sink.onMessage(t)
			}
		case "command_execution":
			if c := strings.TrimSpace(ev.Item.Command); c != "" {
				sink.onCommand(c)
			}
		case "file_change":
			sink.onFileChange()
		case "web_search":
			if q := strings.TrimSpace(ev.Item.Query); q != "" {
				sink.onWebSearch(q)
			}
		case "mcp_tool_call":
			if n := strings.TrimSpace(ev.Item.Name); n != "" {
				sink.onMCPToolCall(n)
			}
		}
	case "turn.failed":
		msg := "unknown error"
		if ev.Error != nil && ev.Error.Message != "" {
			msg = ev.Error.Message
		}
		sink.onTurnFailed(msg)
	case "turn.completed":
		sink.onTurnCompleted()
	}
}

// codexLogSink renders Codex events into the pod-log transcript for one-shot
// runs: the assistant's text is written to stdout untagged so the dashboard
// highlights it; everything else (tool/command activity and lifecycle) is tagged
// [harness] so it renders as dimmed context.
type codexLogSink struct{}

func (codexLogSink) onMessage(text string) { fmt.Fprintln(stdoutTee, text) }

func (codexLogSink) onCommand(command string) {
	log.Printf("[harness] → exec: %s", strings.SplitN(command, "\n", 2)[0])
}

func (codexLogSink) onFileChange() { log.Printf("[harness] → file change") }

func (codexLogSink) onWebSearch(query string) { log.Printf("[harness] → search: %s", query) }

func (codexLogSink) onMCPToolCall(name string) { log.Printf("[harness] → tool: %s", name) }

func (codexLogSink) onTurnFailed(msg string) { log.Printf("[harness] codex turn failed: %s", msg) }

func (codexLogSink) onTurnCompleted() { log.Printf("[harness] codex turn complete") }

// handleCodexEvent renders one NDJSON event into the transcript (the one-shot
// path). It is the log-sink specialization of dispatchCodexEvent.
func handleCodexEvent(raw []byte) { dispatchCodexEvent(raw, codexLogSink{}) }
