package main

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
	"testing"
)

// captureHarnessLog redirects the log package (the transcript sink) to a buffer
// for the duration of fn and returns what was written. Flags are cleared so the
// captured lines are just the tagged text, without a timestamp prefix.
func captureHarnessLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	origOut := log.Writer()
	origFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(origOut)
		log.SetFlags(origFlags)
	}()
	fn()
	return buf.String()
}

// The one-shot log path must record a tool's output so the transcript (and the
// log modal) can show it, matching the interactive proxy. Each line is ←-tagged
// so the frontend can fold the whole result behind a nested expander.
func TestHandleClaudeEventLogsToolResult(t *testing.T) {
	out := captureHarnessLog(t, func() {
		handleClaudeEvent([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"line one\nline two"}]}}`))
	})
	for _, want := range []string{"[harness]   ← line one", "[harness]   ← line two"} {
		if !strings.Contains(out, want) {
			t.Errorf("log = %q, missing %q", out, want)
		}
	}
}

func TestLogToolResult(t *testing.T) {
	// Every line is marked, so a multi-line result folds as one block.
	if got, want := captureHarnessLog(t, func() { logToolResult("", "alpha\nbeta\n") }),
		"[harness]   ← alpha\n[harness]   ← beta\n"; got != want {
		t.Errorf("logToolResult multi-line = %q, want %q", got, want)
	}

	// Blank / whitespace-only output emits nothing, so a resultless call stays a
	// one-liner rather than gaining an empty expander.
	if out := captureHarnessLog(t, func() { logToolResult("", "   \n") }); out != "" {
		t.Errorf("blank result logged %q, want empty", out)
	}
}

// capturingSink records the parentID delivered to each event-scoped callback so
// dispatchClaudeEvent's threading of parent_tool_use_id can be asserted.
type capturingSink struct {
	toolUses    []struct{ id, name, parentID string }
	toolResults []struct{ id, parentID string }
	texts       []struct{ text, parentID string }
	bgTasks     []int
}

func (s *capturingSink) onSlashCommands([]string) {}
func (s *capturingSink) onText(text, parentID string) {
	s.texts = append(s.texts, struct{ text, parentID string }{text, parentID})
}
func (s *capturingSink) onThinking(string, string) {}
func (s *capturingSink) onToolUse(id, name, parentID string, _ json.RawMessage) {
	s.toolUses = append(s.toolUses, struct{ id, name, parentID string }{id, name, parentID})
}
func (s *capturingSink) onToolResult(id, parentID string, _ bool, _ json.RawMessage) {
	s.toolResults = append(s.toolResults, struct{ id, parentID string }{id, parentID})
}
func (s *capturingSink) onResult(claudeEvent) {}
func (s *capturingSink) onBackgroundTasks(active int) {
	s.bgTasks = append(s.bgTasks, active)
}

// The parser must thread the top-level parent_tool_use_id to the sink: empty for
// the main agent (the Agent spawn itself), and the spawning Agent id for every
// event a subagent emits — the sole link that lets a sink attribute subagents.
func TestDispatchThreadsParentToolUseID(t *testing.T) {
	s := &capturingSink{}
	// Main-agent Agent spawn (parent_tool_use_id null).
	dispatchClaudeEvent([]byte(`{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_agent01","name":"Agent","input":{"subagent_type":"Explore","description":"find auth"}}]}}`), s)
	// Subagent's own tool_use, tagged with the spawn id.
	dispatchClaudeEvent([]byte(`{"type":"assistant","parent_tool_use_id":"toolu_agent01","message":{"content":[{"type":"tool_use","id":"toolu_sub01","name":"Read","input":{"file_path":"a.go"}}]}}`), s)
	// Subagent's tool_result, same parent.
	dispatchClaudeEvent([]byte(`{"type":"user","parent_tool_use_id":"toolu_agent01","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_sub01","content":"ok"}]}}`), s)

	if len(s.toolUses) != 2 || s.toolUses[0].parentID != "" || s.toolUses[0].name != "Agent" {
		t.Fatalf("spawn tool_use = %+v, want name=Agent parentID=''", s.toolUses)
	}
	if s.toolUses[1].parentID != "toolu_agent01" {
		t.Errorf("subagent tool_use parentID = %q, want toolu_agent01", s.toolUses[1].parentID)
	}
	if len(s.toolResults) != 1 || s.toolResults[0].parentID != "toolu_agent01" {
		t.Errorf("subagent tool_result = %+v, want parentID=toolu_agent01", s.toolResults)
	}
}

// The parser must surface the count of in-flight background subagent tasks from
// system/background_tasks_changed events, so the driver can tell a mid-turn yield
// (the agent will auto-resume when a task finishes) from a real user-input await.
func TestDispatchRoutesBackgroundTasks(t *testing.T) {
	s := &capturingSink{}
	dispatchClaudeEvent([]byte(`{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a"},{"task_id":"b"}]}`), s)
	dispatchClaudeEvent([]byte(`{"type":"system","subtype":"background_tasks_changed","tasks":[]}`), s)
	if len(s.bgTasks) != 2 || s.bgTasks[0] != 2 || s.bgTasks[1] != 0 {
		t.Fatalf("bgTasks = %v, want [2 0]", s.bgTasks)
	}
}

// toolSummary must label an Agent/Task spawn by subagent_type + description and
// must NOT dump the (long) prompt, which the default branch would.
func TestToolSummaryAgent(t *testing.T) {
	for _, name := range []string{"Agent", "Task"} {
		got := toolSummary(name, json.RawMessage(`{"subagent_type":"Explore","description":"find the auth flow","prompt":"a very long prompt that should never appear in the summary"}`))
		if got != name+"(Explore): find the auth flow" {
			t.Errorf("toolSummary(%s) = %q", name, got)
		}
		if strings.Contains(got, "long prompt") {
			t.Errorf("toolSummary(%s) leaked the prompt: %q", name, got)
		}
	}
}

// toolSummary must label a Workflow by its name — the `name` arg for a saved
// workflow, or the meta.name of an inline script — and never dump the whole
// script, which the default branch would.
func TestToolSummaryWorkflow(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"saved workflow by name", `{"name":"find-flaky-tests"}`, "Workflow: find-flaky-tests"},
		{"inline script meta.name", `{"script":"export const meta = { name: 'review-changes', description: 'x' }; phase('Scan')"}`, "Workflow: review-changes"},
		{"double-quoted meta.name", `{"script":"export const meta = { name: \"audit\" }"}`, "Workflow: audit"},
		{"no name falls back", `{"args":{"q":"x"}}`, "Workflow"},
	}
	for _, c := range cases {
		got := toolSummary("Workflow", json.RawMessage(c.input))
		if got != c.want {
			t.Errorf("%s: toolSummary(Workflow, %s) = %q, want %q", c.name, c.input, got, c.want)
		}
		if strings.Contains(got, "phase(") || strings.Contains(got, "export const") {
			t.Errorf("%s: leaked the script body: %q", c.name, got)
		}
	}
}

// The stateful log sink must attribute a subagent's events: remember the spawn's
// label and tag the subagent's later lines with the subagent marker + label,
// while a subagent's assistant text is folded into [harness] rather than surfaced
// as the run's answer (main-agent text still goes to stdout untagged).
func TestLogSinkSubagentAttribution(t *testing.T) {
	out := captureHarnessLog(t, func() {
		sink := newClaudeLogSink()
		sink.handle([]byte(`{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_agent01","name":"Agent","input":{"subagent_type":"Explore","description":"find auth"}}]}}`))
		sink.handle([]byte(`{"type":"assistant","parent_tool_use_id":"toolu_agent01","message":{"content":[{"type":"tool_use","id":"toolu_sub01","name":"Grep","input":{"pattern":"login"}}]}}`))
		sink.handle([]byte(`{"type":"user","parent_tool_use_id":"toolu_agent01","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_sub01","content":"hit"}]}}`))
	})
	// The spawn renders with the Agent label.
	if !strings.Contains(out, "→ Agent(Explore): find auth") {
		t.Errorf("missing Agent spawn line; got:\n%s", out)
	}
	// The subagent's Grep is marked with the marker + the spawn's label.
	wantChild := "[harness] " + subagentMarker + " Agent(Explore): find auth " + subagentSep + " → Grep: login"
	if !strings.Contains(out, wantChild) {
		t.Errorf("missing attributed subagent tool line %q; got:\n%s", wantChild, out)
	}
}

func TestLogSinkSubagentTextFolded(t *testing.T) {
	sink := newClaudeLogSink()
	// Main-agent text still surfaces untagged (to stdoutTee, not the log).
	mainOut := captureHarnessLog(t, func() {
		sink.handle([]byte(`{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"the answer"}]}}`))
	})
	if strings.Contains(mainOut, "the answer") {
		t.Errorf("main-agent text should go to stdout, not the [harness] log; got:\n%s", mainOut)
	}
	// A subagent's text is folded into [harness], attributed, not surfaced.
	subOut := captureHarnessLog(t, func() {
		sink.handle([]byte(`{"type":"assistant","parent_tool_use_id":"toolu_agent01","message":{"content":[{"type":"text","text":"subagent narration"}]}}`))
	})
	if !strings.Contains(subOut, subagentMarker) || !strings.Contains(subOut, "subagent narration") {
		t.Errorf("subagent text should be folded into [harness] with the marker; got:\n%s", subOut)
	}
}
