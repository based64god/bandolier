package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bandolier/agent-harness/internal/acp"
)

// fakeClaudeSrc is a stand-in for the claude CLI in --input-format stream-json
// mode: for each user message line on stdin it emits one assistant text event
// echoing the message, then a result event, and stays alive for the next turn.
const fakeClaudeSrc = `package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var msg struct {
			Message struct {
				Content []struct {
					Text string ` + "`json:\"text\"`" + `
				} ` + "`json:\"content\"`" + `
			} ` + "`json:\"message\"`" + `
		}
		_ = json.Unmarshal(sc.Bytes(), &msg)
		text := ""
		if len(msg.Message.Content) > 0 {
			text = msg.Message.Content[0].Text
		}
		out, _ := json.Marshal(map[string]any{
			"type": "assistant",
			"message": map[string]any{
				"content": []map[string]any{{"type": "text", "text": "echo: " + text}},
			},
		})
		fmt.Println(string(out))
		fmt.Println(` + "`{\"type\":\"result\",\"num_turns\":1}`" + `)
	}
}
`

// buildFakeClaude compiles the fake CLI to <dir>/claude and returns its dir.
func buildFakeClaude(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "fakeclaude.go")
	if err := os.WriteFile(src, []byte(fakeClaudeSrc), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "claude")
	cmd := exec.Command("go", "build", "-o", bin, src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake claude: %v\n%s", err, out)
	}
	return dir
}

// flagValue returns the argument following flag in args, or "" if absent.
func flagValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// TestClaudeDriverArgs locks the interactive path's forwarding: the ultracode
// system prompt (built upstream by the proxy via config.withRepoPrompt and
// handed over as ACP_SYSTEM_PROMPT) and the effort level must reach the claude
// CLI in interactive mode just as runClaude passes them one-shot.
func TestClaudeDriverArgs(t *testing.T) {
	// A highest-effort Claude run: the proxy's withRepoPrompt output carries the
	// ultracode framing, and the driver must forward it plus --effort <highest>.
	sysPrompt := (config{provider: providerAnthropic, effort: highestEffort}).withRepoPrompt("frame")
	args := claudeDriverArgs(&acpAgent{model: "m", effort: highestEffort, sysPrompt: sysPrompt})
	if got := flagValue(args, "--append-system-prompt"); got != sysPrompt || !strings.Contains(got, ultracodeFraming) {
		t.Errorf("--append-system-prompt = %q, want the ultracode system prompt", got)
	}
	if got := flagValue(args, "--effort"); got != highestEffort {
		t.Errorf("--effort = %q, want %q", got, highestEffort)
	}

	// No effort and no system prompt: neither flag is emitted.
	args = claudeDriverArgs(&acpAgent{model: "m"})
	if flagValue(args, "--append-system-prompt") != "" {
		t.Error("--append-system-prompt emitted with an empty system prompt")
	}
	if flagValue(args, "--effort") != "" {
		t.Error("--effort emitted with no effort set")
	}
}

// captureEmits builds an agent whose emitted session/update frames land in buf,
// for testing event translation in isolation.
func captureEmits(buf io.Writer) *acpAgent {
	conn := acp.NewConn(strings.NewReader(""), buf)
	return &acpAgent{conn: conn, sessionID: "sess-test", curMsgID: "msg-test"}
}

// collectUpdates parses the newline-delimited session/update frames in buf.
func collectUpdates(t *testing.T, buf interface{ String() string }) []acp.ToolCall {
	t.Helper()
	var calls []acp.ToolCall
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var f struct {
			Params struct {
				Update json.RawMessage `json:"update"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(line), &f) != nil {
			continue
		}
		if acp.UpdateKind(f.Params.Update) == acp.UpdateToolCall {
			var tc acp.ToolCall
			_ = json.Unmarshal(f.Params.Update, &tc)
			calls = append(calls, tc)
		}
	}
	return calls
}

func TestClaudeDriverToolCallTranslation(t *testing.T) {
	var buf bytes.Buffer
	a := captureEmits(&buf)
	d := &claudeDriver{agent: a}
	d.handle([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}`))

	calls := collectUpdates(t, &buf)
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1", len(calls))
	}
	if calls[0].Kind != acp.ToolKindExecute {
		t.Errorf("kind = %q, want %q", calls[0].Kind, acp.ToolKindExecute)
	}
	if calls[0].Title != "Bash: ls -la" {
		t.Errorf("title = %q", calls[0].Title)
	}
	if calls[0].Status != acp.ToolStatusPending {
		t.Errorf("status = %q", calls[0].Status)
	}
}

// A subagent's tool calls must carry parentToolCallId = the spawning Agent
// call's id, and the Agent spawn itself must render as kind "subagent" with no
// parent — the linkage the dashboard nests on.
func TestClaudeDriverSubagentNesting(t *testing.T) {
	var buf bytes.Buffer
	a := captureEmits(&buf)
	d := &claudeDriver{agent: a}
	// Main-agent Agent spawn (parent_tool_use_id null), then the subagent's own
	// Read tagged with the spawn id.
	d.handle([]byte(`{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_agent01","name":"Agent","input":{"subagent_type":"Explore","description":"find auth"}}]}}`))
	d.handle([]byte(`{"type":"assistant","parent_tool_use_id":"toolu_agent01","message":{"content":[{"type":"tool_use","id":"toolu_sub01","name":"Read","input":{"file_path":"a.go"}}]}}`))

	calls := collectUpdates(t, &buf)
	if len(calls) != 2 {
		t.Fatalf("got %d tool calls, want 2", len(calls))
	}
	spawn, child := calls[0], calls[1]
	if spawn.Kind != acp.ToolKindSubagent || spawn.ParentToolCallID != "" {
		t.Errorf("spawn = {kind:%q parent:%q}, want {subagent, ''}", spawn.Kind, spawn.ParentToolCallID)
	}
	if spawn.Title != "Agent(Explore): find auth" {
		t.Errorf("spawn title = %q", spawn.Title)
	}
	if child.ParentToolCallID != "toolu_agent01" {
		t.Errorf("child parentToolCallId = %q, want toolu_agent01", child.ParentToolCallID)
	}
	if child.ToolCallID != "toolu_sub01" {
		t.Errorf("child toolCallId = %q, want toolu_sub01", child.ToolCallID)
	}
}

// parseMessageChunks pulls out agent_message_chunk frames with their text and
// parentToolCallId, so subagent-narration attribution can be asserted.
func parseMessageChunks(buf interface{ String() string }) []struct {
	text, parentToolCallID string
} {
	var out []struct{ text, parentToolCallID string }
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var f struct {
			Params struct {
				Update json.RawMessage `json:"update"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(line), &f) != nil {
			continue
		}
		if acp.UpdateKind(f.Params.Update) != acp.UpdateAgentMessageChunk {
			continue
		}
		var c acp.AgentMessageChunk
		_ = json.Unmarshal(f.Params.Update, &c)
		out = append(out, struct{ text, parentToolCallID string }{c.Content.Text, c.ParentToolCallID})
	}
	return out
}

// A subagent's narration must be forwarded tagged with the spawning Agent id, so
// the client can route it to the subagent card; the main agent's text stays
// untagged so it renders in the conversation.
func TestClaudeDriverSubagentNarration(t *testing.T) {
	var buf bytes.Buffer
	a := captureEmits(&buf)
	d := &claudeDriver{agent: a}
	d.handle([]byte(`{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"main answer"}]}}`))
	d.handle([]byte(`{"type":"assistant","parent_tool_use_id":"toolu_agent01","message":{"content":[{"type":"text","text":"subagent thought"}]}}`))

	chunks := parseMessageChunks(&buf)
	if len(chunks) != 2 {
		t.Fatalf("got %d message chunks, want 2", len(chunks))
	}
	if chunks[0].text != "main answer" || chunks[0].parentToolCallID != "" {
		t.Errorf("main chunk = %+v, want text='main answer' parent=''", chunks[0])
	}
	if chunks[1].text != "subagent thought" || chunks[1].parentToolCallID != "toolu_agent01" {
		t.Errorf("subagent chunk = %+v, want parent=toolu_agent01", chunks[1])
	}
}

// collectToolUpdates parses the tool_call_update frames in buf.
func collectToolUpdates(t *testing.T, buf interface{ String() string }) []acp.ToolCallUpdate {
	t.Helper()
	var ups []acp.ToolCallUpdate
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var f struct {
			Params struct {
				Update json.RawMessage `json:"update"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(line), &f) != nil {
			continue
		}
		if acp.UpdateKind(f.Params.Update) == acp.UpdateToolCallUpdate {
			var u acp.ToolCallUpdate
			_ = json.Unmarshal(f.Params.Update, &u)
			ups = append(ups, u)
		}
	}
	return ups
}

func TestClaudeDriverToolResultTranslation(t *testing.T) {
	var buf bytes.Buffer
	a := captureEmits(&buf)
	d := &claudeDriver{agent: a}
	// A tool_use fixes the toolCallId; the follow-up tool_result (a `user`
	// event) must translate to a tool_call_update carrying that id and output.
	d.handle([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"echo hi"}}]}}`))
	d.handle([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"hi\n"}]}}`))

	calls := collectUpdates(t, &buf)
	if len(calls) != 1 || calls[0].ToolCallID != "toolu_9" {
		t.Fatalf("tool call = %+v, want id toolu_9", calls)
	}
	ups := collectToolUpdates(t, &buf)
	if len(ups) != 1 {
		t.Fatalf("got %d tool updates, want 1", len(ups))
	}
	if ups[0].ToolCallID != "toolu_9" {
		t.Errorf("update id = %q, want toolu_9", ups[0].ToolCallID)
	}
	if ups[0].Status != acp.ToolStatusCompleted {
		t.Errorf("status = %q, want completed", ups[0].Status)
	}
	if len(ups[0].Content) != 1 || ups[0].Content[0].Content.Text != "hi\n" {
		t.Errorf("content = %+v, want text %q", ups[0].Content, "hi\n")
	}
}

func TestClaudeDriverToolResultArrayAndError(t *testing.T) {
	var buf bytes.Buffer
	a := captureEmits(&buf)
	d := &claudeDriver{agent: a}
	// A tool_result whose content is an array of blocks, flagged is_error.
	d.handle([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":true,"content":[{"type":"text","text":"boom"}]}]}}`))

	ups := collectToolUpdates(t, &buf)
	if len(ups) != 1 {
		t.Fatalf("got %d tool updates, want 1", len(ups))
	}
	if ups[0].Status != acp.ToolStatusFailed {
		t.Errorf("status = %q, want failed", ups[0].Status)
	}
	if len(ups[0].Content) != 1 || ups[0].Content[0].Content.Text != "boom" {
		t.Errorf("content = %+v, want text %q", ups[0].Content, "boom")
	}
}

// collectAvailableCommands parses the available_commands_update frames in buf.
func collectAvailableCommands(t *testing.T, buf interface{ String() string }) []acp.AvailableCommand {
	t.Helper()
	var cmds []acp.AvailableCommand
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var f struct {
			Params struct {
				Update json.RawMessage `json:"update"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(line), &f) != nil {
			continue
		}
		if acp.UpdateKind(f.Params.Update) == acp.UpdateAvailableCommands {
			var u acp.AvailableCommandsUpdate
			_ = json.Unmarshal(f.Params.Update, &u)
			cmds = append(cmds, u.AvailableCommands...)
		}
	}
	return cmds
}

func TestClaudeDriverAvailableCommands(t *testing.T) {
	var buf bytes.Buffer
	a := captureEmits(&buf)
	d := &claudeDriver{agent: a}
	// The init event lists the session's slash commands.
	d.handle([]byte(`{"type":"system","subtype":"init","slash_commands":["code-review","","verify"]}`))
	// A non-init system event carries no commands and must emit nothing.
	d.handle([]byte(`{"type":"system","subtype":"other","slash_commands":["nope"]}`))

	cmds := collectAvailableCommands(t, &buf)
	if len(cmds) != 2 {
		t.Fatalf("got %d commands, want 2 (blank dropped): %+v", len(cmds), cmds)
	}
	if cmds[0].Name != "code-review" || cmds[1].Name != "verify" {
		t.Errorf("commands = %+v", cmds)
	}
}

func TestACPAgentClaudeTurn(t *testing.T) {
	binDir := buildFakeClaude(t)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	// Force the anthropic provider path regardless of the ambient environment.
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "")
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("WORKING_DIR", t.TempDir())

	// Wire a client Conn to the agent over in-memory pipes.
	clientToAgentR, clientToAgentW := io.Pipe()
	agentToClientR, agentToClientW := io.Pipe()
	go func() { _ = serveACPAgent(clientToAgentR, agentToClientW) }()
	t.Cleanup(func() { _ = clientToAgentW.Close(); _ = agentToClientW.Close() })

	client := acp.NewConn(agentToClientR, clientToAgentW)

	var (
		mu     sync.Mutex
		chunks []string
	)
	client.HandleNotification(acp.MethodSessionUpdate, func(_ context.Context, params json.RawMessage) {
		var n struct {
			Update json.RawMessage `json:"update"`
		}
		if json.Unmarshal(params, &n) != nil {
			return
		}
		if acp.UpdateKind(n.Update) != acp.UpdateAgentMessageChunk {
			return
		}
		var u acp.AgentMessageChunk
		_ = json.Unmarshal(n.Update, &u)
		mu.Lock()
		chunks = append(chunks, u.Content.Text)
		mu.Unlock()
	})
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var initRes acp.InitializeResult
	if err := client.CallResult(ctx, acp.MethodInitialize, acp.InitializeParams{ProtocolVersion: acp.ProtocolVersion}, &initRes); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if initRes.ProtocolVersion != acp.ProtocolVersion {
		t.Fatalf("protocol version = %d", initRes.ProtocolVersion)
	}

	var sess acp.NewSessionResult
	if err := client.CallResult(ctx, acp.MethodNewSession, acp.NewSessionParams{Cwd: os.Getenv("WORKING_DIR"), MCPServers: []acp.MCPServer{}}, &sess); err != nil {
		t.Fatalf("session/new: %v", err)
	}
	if sess.SessionID == "" {
		t.Fatal("empty session id")
	}

	// Two turns over the same long-lived session.
	for _, msg := range []string{"hello", "again"} {
		var res acp.PromptResult
		err := client.CallResult(ctx, acp.MethodPrompt, acp.PromptParams{
			SessionID: sess.SessionID,
			Prompt:    []acp.ContentBlock{acp.TextBlock(msg)},
		}, &res)
		if err != nil {
			t.Fatalf("prompt %q: %v", msg, err)
		}
		if res.StopReason != acp.StopEndTurn {
			t.Fatalf("prompt %q stopReason = %q, want %q", msg, res.StopReason, acp.StopEndTurn)
		}
	}

	// Message chunks are delivered asynchronously as session/update
	// notifications, which can lag the prompt response, so wait for both turns.
	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(chunks) == 2
	})
	mu.Lock()
	defer mu.Unlock()
	if chunks[0] != "echo: hello" || chunks[1] != "echo: again" {
		t.Fatalf("unexpected chunks: %v", chunks)
	}
}

// A result that arrives while a background subagent task is still in flight is a
// mid-turn yield — the CLI auto-resumes the agent (no user message) when the task
// finishes — not the end of the user's turn. The driver must hold the ACP turn
// open on it, or the prompt ends early and a spurious "waiting for input"
// notification fires while the agent is merely waiting on its subagent. The turn
// completes only on the result that arrives once the background set drains.
func TestClaudeDriverHoldsTurnForBackgroundTasks(t *testing.T) {
	d := &claudeDriver{turnDone: make(chan acp.PromptResult, 1), agent: &acpAgent{}}

	// A background subagent spawns: one task now in flight.
	d.handle([]byte(`{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"t1"}]}`))
	// The agent yields its turn — this result must be swallowed, not completed.
	d.handle([]byte(`{"type":"result","stop_reason":"end_turn","num_turns":2}`))
	select {
	case r := <-d.turnDone:
		t.Fatalf("turn completed on a background yield (stopReason=%q); want it held open", r.StopReason)
	default:
	}

	// The task finishes and the background set drains to empty.
	d.handle([]byte(`{"type":"system","subtype":"background_tasks_changed","tasks":[]}`))
	// The agent auto-resumes and truly finishes — now the turn completes.
	d.handle([]byte(`{"type":"result","stop_reason":"end_turn","num_turns":1}`))
	select {
	case r := <-d.turnDone:
		if r.StopReason != acp.StopEndTurn {
			t.Fatalf("final stopReason = %q, want %q", r.StopReason, acp.StopEndTurn)
		}
	default:
		t.Fatal("turn did not complete after background tasks drained")
	}
}

// discardWriteCloser is a stdin stand-in for a driver whose CLI is never actually
// spawned (the test drives the sink directly).
type discardWriteCloser struct{}

func (discardWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (discardWriteCloser) Close() error                { return nil }

// The in-flight background-task count must not leak across turns. A turn that ends
// abnormally — a session/cancel while a background subagent is still running —
// makes promptClaude return before the background set drains, leaving the count
// non-zero. The next turn must reset it, or its own end-of-turn result is wrongly
// held open and the turn hangs. promptClaude clears the count at turn start; drive
// a real prompt with a stale count and assert the turn still completes.
func TestPromptClaudeResetsStaleBackgroundCount(t *testing.T) {
	d := &claudeDriver{stdin: discardWriteCloser{}, turnDone: make(chan acp.PromptResult, 1)}
	a := &acpAgent{claude: d}
	d.agent = a
	d.bgActive.Store(3) // stale count left by a cancelled prior turn

	res := make(chan acp.PromptResult, 1)
	go func() {
		r, _ := a.promptClaude(context.Background(), "hello")
		res <- r.(acp.PromptResult)
	}()

	// promptClaude resets the count before it blocks waiting for the turn result.
	waitFor(t, func() bool { return d.bgActive.Load() == 0 })
	// The turn finishes with no background work: it must complete, not be swallowed.
	d.handle([]byte(`{"type":"result","stop_reason":"end_turn"}`))

	select {
	case r := <-res:
		if r.StopReason != acp.StopEndTurn {
			t.Fatalf("stopReason = %q, want %q", r.StopReason, acp.StopEndTurn)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("promptClaude hung: a stale background count leaked across turns")
	}
}
