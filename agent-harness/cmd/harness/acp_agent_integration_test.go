package main

// Integration tests for the ACP agent's control-plane semantics: the exact
// JSON-RPC error codes and cancellation behavior a real client sees when it
// drives serveACPAgent over a live acp.Conn pipe. The unit tests in
// acp_agent_test.go cover event translation in isolation; these drive the whole
// request/response loop through the real Conn dispatcher and assert the codes
// and stop reasons the frontend depends on.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/bandolier/agent-harness/internal/acp"
)

// blockingFakeClaudeSrc is fakeClaudeSrc plus a hang sentinel: a user message
// containing __HANG__ makes the fake emit its assistant chunk but never a
// result, so the turn stays in-flight until the client cancels it. The process
// keeps scanning stdin, so it stays alive (no result, no busy-loop) — only
// cancellation ends the turn. Any other message echoes and completes normally.
const blockingFakeClaudeSrc = `package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
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
		if strings.Contains(text, "__HANG__") {
			// Emit the chunk but no result: the turn hangs until cancellation.
			continue
		}
		fmt.Println(` + "`{\"type\":\"result\",\"num_turns\":1}`" + `)
	}
}
`

// buildBlockingFakeClaude compiles the hang-aware fake CLI to <dir>/claude.
func buildBlockingFakeClaude(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "fakeclaude.go")
	if err := os.WriteFile(src, []byte(blockingFakeClaudeSrc), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "claude")
	if out, err := exec.Command("go", "build", "-o", bin, src).CombinedOutput(); err != nil {
		t.Fatalf("build blocking fake claude: %v\n%s", err, out)
	}
	return dir
}

// setAnthropicEnv forces the anthropic provider path regardless of the ambient
// environment, so provider detection is deterministic.
func setAnthropicEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "")
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
}

// newACPAgentClient wires an unstarted client Conn to a fresh serveACPAgent over
// in-memory pipes. The caller registers handlers, then calls Start.
func newACPAgentClient(t *testing.T) *acp.Conn {
	t.Helper()
	clientToAgentR, clientToAgentW := io.Pipe()
	agentToClientR, agentToClientW := io.Pipe()
	go func() { _ = serveACPAgent(clientToAgentR, agentToClientW) }()
	t.Cleanup(func() {
		_ = clientToAgentW.Close()
		_ = agentToClientW.Close()
	})
	return acp.NewConn(agentToClientR, clientToAgentW)
}

// assertRPCCode fails unless err is an *acp.RPCError with the given code.
func assertRPCCode(t *testing.T, err error, code int) *acp.RPCError {
	t.Helper()
	if err == nil {
		t.Fatalf("want RPC error code %d, got nil", code)
	}
	var rpc *acp.RPCError
	if !errors.As(err, &rpc) {
		t.Fatalf("want *acp.RPCError, got %T: %v", err, err)
	}
	if rpc.Code != code {
		t.Errorf("RPC code = %d (%q), want %d", rpc.Code, rpc.Message, code)
	}
	return rpc
}

// TestACPAgentErrorSemantics locks the JSON-RPC error codes the agent returns on
// the misuse paths a frontend can hit: prompting before a session, malformed
// params, a claude that fails to launch, and a duplicate session.
func TestACPAgentErrorSemantics(t *testing.T) {
	setAnthropicEnv(t)

	call := func(t *testing.T, client *acp.Conn, method string, params any) error {
		client.Start()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return client.CallResult(ctx, method, params, nil)
	}

	t.Run("prompt before session/new is an invalid request", func(t *testing.T) {
		err := call(t, newACPAgentClient(t), acp.MethodPrompt,
			acp.PromptParams{Prompt: []acp.ContentBlock{acp.TextBlock("hi")}})
		assertRPCCode(t, err, acp.CodeInvalidRequest)
	})

	t.Run("malformed session/new params are invalid params", func(t *testing.T) {
		// A JSON string where the handler expects an object.
		err := call(t, newACPAgentClient(t), acp.MethodNewSession, json.RawMessage(`"not-an-object"`))
		assertRPCCode(t, err, acp.CodeInvalidParams)
	})

	t.Run("malformed prompt params are invalid params", func(t *testing.T) {
		err := call(t, newACPAgentClient(t), acp.MethodPrompt, json.RawMessage(`42`))
		assertRPCCode(t, err, acp.CodeInvalidParams)
	})

	t.Run("claude that fails to launch is an internal error and resets the session", func(t *testing.T) {
		// A PATH with no claude binary makes startClaudeDriver fail.
		t.Setenv("PATH", t.TempDir())
		client := newACPAgentClient(t)
		client.Start()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		err := client.CallResult(ctx, acp.MethodNewSession, acp.NewSessionParams{Cwd: t.TempDir()}, nil)
		assertRPCCode(t, err, acp.CodeInternalError)
		// The failed attempt reset sessionID, so a retry fails the same way
		// rather than reporting "session already started".
		err = client.CallResult(ctx, acp.MethodNewSession, acp.NewSessionParams{Cwd: t.TempDir()}, nil)
		assertRPCCode(t, err, acp.CodeInternalError)
	})

	t.Run("a second session/new reports session already started", func(t *testing.T) {
		binDir := buildFakeClaude(t)
		t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		client := newACPAgentClient(t)
		client.Start()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		var sess acp.NewSessionResult
		if err := client.CallResult(ctx, acp.MethodNewSession, acp.NewSessionParams{Cwd: t.TempDir(), MCPServers: []acp.MCPServer{}}, &sess); err != nil {
			t.Fatalf("first session/new: %v", err)
		}
		if sess.SessionID == "" {
			t.Fatal("empty session id from the first session/new")
		}
		err := client.CallResult(ctx, acp.MethodNewSession, acp.NewSessionParams{Cwd: t.TempDir()}, nil)
		rpc := assertRPCCode(t, err, acp.CodeInvalidRequest)
		if rpc != nil && rpc.Message != "session already started" {
			t.Errorf("message = %q, want %q", rpc.Message, "session already started")
		}
	})
}

// TestACPAgentCancellation drives a real turn to a hang, then sends a
// session/cancel notification and asserts the in-flight prompt returns
// stopReason=cancelled rather than completing or erroring.
func TestACPAgentCancellation(t *testing.T) {
	setAnthropicEnv(t)
	binDir := buildBlockingFakeClaude(t)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := newACPAgentClient(t)
	// Signal when the agent has started the turn (emitted its message chunk),
	// so we cancel a genuinely in-flight turn, not a race before it began.
	started := make(chan struct{}, 1)
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
		select {
		case started <- struct{}{}:
		default:
		}
	})
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.CallResult(ctx, acp.MethodInitialize, acp.InitializeParams{ProtocolVersion: acp.ProtocolVersion}, nil); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	var sess acp.NewSessionResult
	if err := client.CallResult(ctx, acp.MethodNewSession, acp.NewSessionParams{Cwd: t.TempDir(), MCPServers: []acp.MCPServer{}}, &sess); err != nil {
		t.Fatalf("session/new: %v", err)
	}

	// Fire the hanging prompt; it will not complete until cancelled.
	resCh := make(chan acp.PromptResult, 1)
	errCh := make(chan error, 1)
	go func() {
		var res acp.PromptResult
		if err := client.CallResult(ctx, acp.MethodPrompt, acp.PromptParams{
			SessionID: sess.SessionID,
			Prompt:    []acp.ContentBlock{acp.TextBlock("please __HANG__ now")},
		}, &res); err != nil {
			errCh <- err
			return
		}
		resCh <- res
	}()

	select {
	case <-started:
	case <-time.After(15 * time.Second):
		t.Fatal("turn never started")
	}

	if err := client.Notify(acp.MethodCancel, map[string]any{"sessionId": sess.SessionID}); err != nil {
		t.Fatalf("cancel notify: %v", err)
	}

	select {
	case res := <-resCh:
		if res.StopReason != acp.StopCancelled {
			t.Fatalf("stopReason = %q, want %q", res.StopReason, acp.StopCancelled)
		}
	case err := <-errCh:
		t.Fatalf("prompt errored instead of cancelling: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatal("cancel did not end the in-flight turn")
	}
}
