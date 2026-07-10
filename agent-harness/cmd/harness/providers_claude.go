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
	// ParentToolUseID links an event produced inside a subagent (spawned via the
	// Agent/Task tool) back to the spawning tool_use block's id. It is a
	// top-level field (sibling of Type/Message), empty on main-agent events and
	// equal to the Agent tool_use id for every assistant/user event the subagent
	// emits — the sole thread that lets us attribute subagent activity. Nested
	// subagents chain it to their immediate parent, so one field reconstructs the
	// whole tree. See https://code.claude.com/docs/en/agent-sdk/subagents.
	ParentToolUseID string `json:"parent_tool_use_id"`
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
// The event-scoped callbacks carry parentID: empty for the main agent, or the
// spawning Agent/Task tool_use id when the event came from a subagent, so each
// sink can attribute the activity. onSlashCommands/onResult are never
// subagent-scoped (system/result events), so they take no parentID.
type claudeEventSink interface {
	onSlashCommands(names []string)
	onText(text, parentID string)
	onThinking(text, parentID string)
	onToolUse(id, name, parentID string, input json.RawMessage)
	onToolResult(id, parentID string, isError bool, content json.RawMessage)
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
					sink.onText(t, ev.ParentToolUseID)
				}
			case "thinking":
				if t := strings.TrimSpace(c.Thinking); t != "" {
					sink.onThinking(t, ev.ParentToolUseID)
				}
			case "tool_use":
				sink.onToolUse(c.ID, c.Name, ev.ParentToolUseID, c.Input)
			}
		}
	case "user":
		// Claude reports each tool's output as a tool_result block on a `user`
		// event.
		for _, c := range ev.Message.Content {
			if c.Type != "tool_result" || c.ToolUseID == "" {
				continue
			}
			sink.onToolResult(c.ToolUseID, ev.ParentToolUseID, c.IsError, c.ToolResult)
		}
	case "result":
		sink.onResult(ev)
	}
}

// claudeLogSink renders Claude events into the pod-log transcript for one-shot
// runs: assistant text goes to stdout untagged so the dashboard highlights it,
// while thinking, tool use, and lifecycle events are tagged [harness] so they
// render as dimmed context. It is stateful across a run's events (one sink per
// run — see runClaudeStreaming) so it can remember each subagent's label and
// attribute that subagent's later events back to it.
type claudeLogSink struct {
	// labels maps an Agent/Task tool_use id to a short human label, populated
	// when the spawn is seen so a subagent's events — which carry that id as
	// their parentID — can be tagged with which subagent produced them.
	labels map[string]string
}

func newClaudeLogSink() *claudeLogSink { return &claudeLogSink{labels: map[string]string{}} }

// handle is the per-line entry point bound into forEachLine, so every line of a
// run drives the same (stateful) sink rather than a fresh one.
func (s *claudeLogSink) handle(raw []byte) { dispatchClaudeEvent(raw, s) }

// subagentPrefix is the marker inserted after the [harness] tag on a line that
// belongs to a subagent, naming which one. Empty for main-agent events, so
// their lines render exactly as before. The frontend (log-segments.ts) folds
// consecutive lines carrying this marker into a labelled subagent block.
func (s *claudeLogSink) subagentPrefix(parentID string) string {
	if parentID == "" {
		return ""
	}
	return subagentLinePrefix(s.labels[parentID])
}

func (*claudeLogSink) onSlashCommands([]string) {}

func (s *claudeLogSink) onText(text, parentID string) {
	if parentID == "" {
		fmt.Fprintln(stdoutTee, text)
		return
	}
	// A subagent's assistant text is narration, not the run's answer — fold it
	// into the [harness] context, attributed to the subagent, rather than
	// letting it surface as the highlighted final output.
	prefix := s.subagentPrefix(parentID)
	for _, l := range strings.Split(text, "\n") {
		log.Printf("[harness] %s%s", prefix, l)
	}
}

func (s *claudeLogSink) onThinking(text, parentID string) {
	prefix := s.subagentPrefix(parentID)
	lines := strings.Split(text, "\n")
	log.Printf("[harness] %s(thinking) %s", prefix, lines[0])
	for _, l := range lines[1:] {
		log.Printf("[harness] %s    %s", prefix, l)
	}
}

func (s *claudeLogSink) onToolUse(id, name, parentID string, input json.RawMessage) {
	// Remember an Agent/Task spawn's label so its subagent's later events can be
	// attributed back to it (they carry this id as their parentID).
	if isAgentTool(name) {
		s.labels[id] = toolSummary(name, input)
	}
	logToolUse(s.subagentPrefix(parentID), name, input)
}

func (s *claudeLogSink) onToolResult(_, parentID string, _ bool, content json.RawMessage) {
	logToolResult(s.subagentPrefix(parentID), toolResultText(content))
}

func (*claudeLogSink) onResult(ev claudeEvent) {
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
// path). It is the log-sink specialization of dispatchClaudeEvent. It builds a
// fresh sink per call, so it's only for single-event use (tests); a real run
// uses one sink across all lines via newClaudeLogSink + handle.
func handleClaudeEvent(raw []byte) { dispatchClaudeEvent(raw, newClaudeLogSink()) }

// subagentMarker tags a [harness] transcript line as belonging to a subagent;
// subagentSep separates the subagent's label from the line body. Both are kept
// byte-identical to the frontend (SUBAGENT_MARKER / SUBAGENT_SEP in
// log-segments.ts), which folds these lines into a labelled block — the same
// contract as the ← output marker. Chosen as glyphs that don't occur in tool
// summaries or output.
const (
	subagentMarker = "⇉"
	subagentSep    = "⟫"
)

// isAgentTool reports whether a tool name spawns a subagent. Claude renamed the
// tool from "Task" to "Agent" in CLI v2.1.63; both names still appear (e.g.
// permission_denials keep "Task"), so match either.
func isAgentTool(name string) bool { return name == "Agent" || name == "Task" }

// subagentLinePrefix builds the marker inserted after the [harness] tag on a
// subagent's transcript line, naming which subagent produced it. Shared by both
// render paths (the one-shot log sink and the interactive proxy) so they emit
// the same ⇉ <label> ⟫ form the frontend folds. An empty label falls back to a
// generic name (the interactive proxy doesn't track per-subagent labels).
func subagentLinePrefix(label string) string {
	if label == "" {
		label = "subagent"
	}
	return subagentMarker + " " + label + " " + subagentSep + " "
}

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
	case isAgentTool(name): // Agent / Task — a subagent spawn
		// Label from subagent_type + the short description; deliberately drop the
		// (long) prompt so the summary stays one readable line.
		kind := str("subagent_type")
		if kind == "" {
			kind = "agent"
		}
		if d := str("description"); d != "" {
			return fmt.Sprintf("%s(%s): %s", name, kind, d)
		}
		return fmt.Sprintf("%s(%s)", name, kind)
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
// prefix is inserted after the [harness] tag: empty for a main-agent call, or a
// subagentPrefix naming the subagent that made it.
func logToolUse(prefix, name string, input json.RawMessage) {
	lines := strings.Split(toolSummary(name, input), "\n")
	log.Printf("[harness] %s→ %s", prefix, lines[0])
	for _, l := range lines[1:] {
		log.Printf("[harness] %s    %s", prefix, l)
	}
}

// logToolResult logs a tool call's captured output (stdout/stderr) into the
// transcript — the output counterpart to logToolUse's → lines. Every line is
// marked with the ← tag (not just the first) so the log renderer can fold the
// whole block behind a nested expander without having to guess where it ends;
// the frontend parser (harnessOutputText in log-segments.ts) reads the bytes
// this writes. The text is already truncated by the caller; empty output emits
// nothing so a resultless call stays a plain one-line entry.
func logToolResult(prefix, text string) {
	text = strings.TrimRight(text, "\n")
	if strings.TrimSpace(text) == "" {
		return
	}
	for _, l := range strings.Split(text, "\n") {
		log.Printf("[harness]   %s← %s", prefix, l)
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

	// One sink for the whole run so it can remember each subagent's label across
	// lines and attribute that subagent's later events (a fresh per-line sink
	// would forget the spawn).
	forEachLine(stdout, newClaudeLogSink().handle)

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
