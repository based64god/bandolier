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

func TestCodexEventToolCallTranslation(t *testing.T) {
	var buf bytes.Buffer
	a := captureEmits(&buf)
	a.handleCodexEvent([]byte(`{"type":"item.completed","item":{"type":"command_execution","command":"go test ./..."}}`))
	a.handleCodexEvent([]byte(`{"type":"item.completed","item":{"type":"web_search","query":"acp spec"}}`))

	calls := collectUpdates(t, &buf)
	if len(calls) != 2 {
		t.Fatalf("got %d tool calls, want 2", len(calls))
	}
	if calls[0].Kind != acp.ToolKindExecute || calls[0].Title != "exec: go test ./..." {
		t.Errorf("exec call = %+v", calls[0])
	}
	if calls[1].Kind != acp.ToolKindFetch || calls[1].Title != "search: acp spec" {
		t.Errorf("search call = %+v", calls[1])
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
