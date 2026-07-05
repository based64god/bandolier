package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strings"
)

// ── Claude stream-json events ─────────────────────────────────────────────────
//
// Claude Code's stream-json is parsed once, by dispatchClaudeEvent, into a set
// of normalized callbacks on a claudeEventSink. Two sinks consume the same
// events without re-interpreting the wire format: claudeLogSink renders them
// into the pod-log transcript (one-shot runs) and the ACP driver forwards them
// as session/update frames (interactive runs). Keeping one parser is what stops
// the two paths from drifting on which fields (thinking, slash commands, tool
// results) they understand.

// claudeEvent is the subset of Claude Code's stream-json events we render.
type claudeEvent struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	// SlashCommands is carried by the system/init event: the command names
	// (no leading slash, no descriptions) the session supports.
	SlashCommands []string `json:"slash_commands"`
	NumTurns      int      `json:"num_turns"`
	IsError       bool     `json:"is_error"`
	Message       struct {
		Content []struct {
			Type     string          `json:"type"`
			Text     string          `json:"text"`
			Thinking string          `json:"thinking"`
			Name     string          `json:"name"`
			Input    json.RawMessage `json:"input"`
			// ID is the tool_use block's id; ToolUseID / ToolResult / IsError
			// carry the matching tool_result (from the follow-up `user` event)
			// so the output can be correlated back to its call.
			ID         string          `json:"id"`
			ToolUseID  string          `json:"tool_use_id"`
			ToolResult json.RawMessage `json:"content"`
			IsError    bool            `json:"is_error"`
		} `json:"content"`
	} `json:"message"`
	// Usage is carried by the terminal `result` event: the run's cumulative
	// token totals across every turn. Zero-valued for non-result events.
	Usage tokenUsage `json:"usage"`
}

// claudeEventSink receives the normalized events dispatchClaudeEvent extracts
// from one stream-json line. Every event kind is delivered to the sink; how (or
// whether) it renders is the sink's choice, not the parser's.
type claudeEventSink interface {
	onSlashCommands(names []string)
	onText(text string)
	onThinking(text string)
	onToolUse(id, name string, input json.RawMessage)
	onToolResult(id string, isError bool, content json.RawMessage)
	onResult(ev claudeEvent)
}

// dispatchClaudeEvent parses one stream-json line and drives the sink. Anything
// that isn't a recognized JSON event is ignored.
func dispatchClaudeEvent(raw []byte, sink claudeEventSink) {
	var ev claudeEvent
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	switch ev.Type {
	case "system":
		// The init event (emitted once at startup) lists the session's slash
		// commands.
		if ev.Subtype == "init" && len(ev.SlashCommands) > 0 {
			sink.onSlashCommands(ev.SlashCommands)
		}
	case "assistant":
		for _, c := range ev.Message.Content {
			switch c.Type {
			case "text":
				if t := strings.TrimSpace(c.Text); t != "" {
					sink.onText(t)
				}
			case "thinking":
				if t := strings.TrimSpace(c.Thinking); t != "" {
					sink.onThinking(t)
				}
			case "tool_use":
				sink.onToolUse(c.ID, c.Name, c.Input)
			}
		}
	case "user":
		// Claude reports each tool's output as a tool_result block on a `user`
		// event.
		for _, c := range ev.Message.Content {
			if c.Type != "tool_result" || c.ToolUseID == "" {
				continue
			}
			sink.onToolResult(c.ToolUseID, c.IsError, c.ToolResult)
		}
	case "result":
		sink.onResult(ev)
	}
}

// claudeLogSink renders Claude events into the pod-log transcript for one-shot
// runs: assistant text goes to stdout untagged so the dashboard highlights it,
// while thinking, tool use, and lifecycle events are tagged [harness] so they
// render as dimmed context.
type claudeLogSink struct{}

func (claudeLogSink) onSlashCommands([]string) {}

func (claudeLogSink) onText(text string) { fmt.Fprintln(stdoutTee, text) }

func (claudeLogSink) onThinking(text string) {
	lines := strings.Split(text, "\n")
	log.Printf("[harness] (thinking) %s", lines[0])
	for _, l := range lines[1:] {
		log.Printf("[harness]     %s", l)
	}
}

func (claudeLogSink) onToolUse(_, name string, input json.RawMessage) { logToolUse(name, input) }

func (claudeLogSink) onToolResult(string, bool, json.RawMessage) {}

func (claudeLogSink) onResult(ev claudeEvent) {
	if ev.IsError {
		log.Printf("[harness] claude finished with error (turns=%d)", ev.NumTurns)
	} else {
		log.Printf("[harness] claude finished (turns=%d)", ev.NumTurns)
	}
	// The result event's usage is the run's cumulative total — emit it as the
	// token marker so Bandolier can surface and persist it.
	logTokenUsage(ev.Usage)
}

// handleClaudeEvent renders one NDJSON event into the transcript (the one-shot
// path). It is the log-sink specialization of dispatchClaudeEvent.
func handleClaudeEvent(raw []byte) { dispatchClaudeEvent(raw, claudeLogSink{}) }

// maxToolOutput caps how much of a tool result we forward as a tool_call_update:
// results can be huge (a full file read, a long command's stdout), and both the
// pod-log transcript and the relayed frame carry the text, so we truncate to
// keep them bounded. The UI collapses the output behind an expander regardless.
const maxToolOutput = 12000

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

// toolResultText renders a Claude tool_result's `content` — which is either a
// bare string or an array of content blocks — as plain text, truncating to
// maxToolOutput characters.
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var out string
	var s string
	if json.Unmarshal(raw, &s) == nil {
		out = s
	} else {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &blocks) == nil {
			var b strings.Builder
			for _, blk := range blocks {
				b.WriteString(blk.Text)
			}
			out = b.String()
		}
	}
	if len(out) > maxToolOutput {
		out = out[:maxToolOutput] + "\n… (truncated)"
	}
	return out
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

	forEachLine(stdout, handleClaudeEvent)

	waitErr := cmd.Wait()
	stderr.flush()
	return waitErr
}

// runClaude drives the claude CLI for a one-shot agent pass over stream-json.
func runClaude(ctx context.Context, cfg config) error {
	// stream-json emits NDJSON events as they happen so output appears
	// incrementally rather than all at once when the run finishes.
	claudeArgs := []string{
		"--print",
		"--model", cfg.model,
		"--dangerously-skip-permissions",
		"--output-format", "stream-json",
		"--verbose", // required for stream-json in print mode
	}
	if cfg.effort != "" {
		claudeArgs = append(claudeArgs, "--effort", cfg.effort)
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
	logCodexPrompt("starting claude with prompt:", sysPrompt, cfg.task)
	return runClaudeStreaming(ctx, cfg.workDir, buildEnv(cfg.provider), claudeArgs...)
}
