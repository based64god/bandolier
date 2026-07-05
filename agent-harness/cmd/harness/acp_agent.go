package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/bandolier/agent-harness/internal/acp"
)

// ── ACP agent server ──────────────────────────────────────────────────────────
//
// `harness acp-agent` runs the agent (server) side of the Agent Client Protocol:
// it reads ACP JSON-RPC from stdin and writes it to stdout, wrapping the
// underlying coding CLI (claude or codex) so any ACP client can drive it. The
// harness's proxy mode spawns this and relays the frontend's frames to it; the
// underlying CLI does its own filesystem I/O (run with skip-permissions), so the
// client never needs to serve fs/* or terminal/* requests.
//
// stdout is reserved for the JSON-RPC channel; all diagnostics go to stderr.

type acpAgent struct {
	provider  providerKind
	model     string
	effort    string
	workDir   string
	sysPrompt string

	conn *acp.Conn

	mu         sync.Mutex
	sessionID  string
	claude     *claudeDriver // long-lived process for the claude providers
	codexBegun bool          // codex runs one process per turn; resume after the first
	curMsgID   string        // message id for the in-flight turn's chunks
	cancelTurn context.CancelFunc
	// tokens is the session-wide running total: a long-lived interactive process
	// drives many turns, so each turn's result usage is summed and the cumulative
	// figure re-emitted as the token marker (the server greps the latest).
	tokens tokenUsage

	turnMu sync.Mutex // serialize prompt turns
}

// runACPAgent is the entry point for the `acp-agent` subcommand. It reserves
// stdout for the JSON-RPC channel and serves until the peer closes stdin.
func runACPAgent() error {
	log.SetFlags(log.Ltime)
	log.SetOutput(os.Stderr) // stdout carries the JSON-RPC channel
	return serveACPAgent(os.Stdin, os.Stdout)
}

// serveACPAgent wires an ACP agent over the given streams. Split out from
// runACPAgent so tests can drive it in-process over pipes.
func serveACPAgent(in io.Reader, out io.Writer) error {
	a := &acpAgent{
		provider:  detectProvider(),
		model:     getenvDefault("CLAUDE_MODEL", "claude-sonnet-4-6"),
		effort:    normalizeEffort(os.Getenv("CLAUDE_EFFORT")),
		workDir:   getenvDefault("WORKING_DIR", "/workspace"),
		sysPrompt: os.Getenv("ACP_SYSTEM_PROMPT"),
	}
	conn := acp.NewConn(in, out)
	a.conn = conn
	conn.Handle(acp.MethodInitialize, a.initialize)
	conn.Handle(acp.MethodNewSession, a.newSession)
	conn.Handle(acp.MethodPrompt, a.prompt)
	conn.HandleNotification(acp.MethodCancel, a.cancel)
	conn.OnError(func(err error) { log.Printf("acp-agent: %v", err) })
	// Log before Start: newSession (dispatched once the loops run) can mutate
	// a.workDir, so read it here, before the read loop launches.
	log.Printf("acp-agent: ready (provider=%s model=%s cwd=%s)", a.provider, a.model, a.workDir)
	conn.Start()
	return conn.Wait()
}

func (a *acpAgent) initialize(context.Context, json.RawMessage) (any, error) {
	return acp.InitializeResult{
		ProtocolVersion:   acp.ProtocolVersion,
		AgentCapabilities: acp.AgentCapabilities{PromptCapabilities: acp.PromptCapabilities{}},
		AgentInfo:         &acp.Implementation{Name: "bandolier-acp-agent", Version: "0.1.0"},
		AuthMethods:       []acp.AuthMethod{},
	}, nil
}

func (a *acpAgent) newSession(_ context.Context, params json.RawMessage) (any, error) {
	var p acp.NewSessionParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &acp.RPCError{Code: acp.CodeInvalidParams, Message: err.Error()}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sessionID != "" {
		return nil, &acp.RPCError{Code: acp.CodeInvalidRequest, Message: "session already started"}
	}
	if p.Cwd != "" {
		a.workDir = p.Cwd
	}
	a.sessionID = "sess-" + shortUnique()
	// The claude providers keep one long-lived process so conversation context
	// persists across turns; codex resumes a persisted session per turn instead.
	if a.provider != providerOpenAI && a.provider != providerGemini {
		d, err := startClaudeDriver(a)
		if err != nil {
			a.sessionID = ""
			return nil, &acp.RPCError{Code: acp.CodeInternalError, Message: "start claude: " + err.Error()}
		}
		a.claude = d
	}
	return acp.NewSessionResult{SessionID: a.sessionID}, nil
}

func (a *acpAgent) prompt(_ context.Context, params json.RawMessage) (any, error) {
	var p acp.PromptParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &acp.RPCError{Code: acp.CodeInvalidParams, Message: err.Error()}
	}
	a.mu.Lock()
	started := a.sessionID != ""
	a.mu.Unlock()
	if !started {
		return nil, &acp.RPCError{Code: acp.CodeInvalidRequest, Message: "no active session"}
	}

	a.turnMu.Lock()
	defer a.turnMu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	a.cancelTurn = cancel
	a.curMsgID = "msg-" + shortUnique()
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.cancelTurn = nil
		a.mu.Unlock()
		cancel()
	}()

	text := promptText(p.Prompt)
	if a.provider == providerOpenAI {
		return a.promptCodex(ctx, text)
	}
	return a.promptClaude(ctx, text)
}

// cancel handles a session/cancel notification by cancelling the in-flight turn.
func (a *acpAgent) cancel(context.Context, json.RawMessage) {
	a.mu.Lock()
	c := a.cancelTurn
	a.mu.Unlock()
	if c != nil {
		c()
	}
}

// emit sends a session/update notification carrying one update variant.
func (a *acpAgent) emit(update any) {
	if err := a.conn.Notify(acp.MethodSessionUpdate, acp.SessionNotification{SessionID: a.sessionID, Update: update}); err != nil {
		log.Printf("acp-agent: emit failed: %v", err)
	}
}

// ── Claude driver (long-lived stream-json process) ────────────────────────────

type claudeDriver struct {
	stdin    io.WriteCloser
	turnDone chan acp.PromptResult
	agent    *acpAgent
}

func startClaudeDriver(a *acpAgent) (*claudeDriver, error) {
	args := []string{
		"--print",
		"--model", a.model,
		"--dangerously-skip-permissions",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
	}
	if a.effort != "" {
		args = append(args, "--effort", a.effort)
	}
	if a.sysPrompt != "" {
		args = append(args, "--append-system-prompt", a.sysPrompt)
	}
	cmd := exec.Command("claude", args...)
	cmd.Dir = a.workDir
	cmd.Env = buildEnv(a.provider)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	d := &claudeDriver{stdin: stdin, turnDone: make(chan acp.PromptResult, 1), agent: a}
	go d.read(stdout)
	return d, nil
}

func (d *claudeDriver) read(stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			d.handle(line)
		}
		if err != nil {
			// Process exited: unblock any turn still waiting on a result event.
			select {
			case d.turnDone <- acp.PromptResult{StopReason: acp.StopEndTurn}:
			default:
			}
			return
		}
	}
}

func (d *claudeDriver) handle(raw []byte) {
	var ev claudeEvent
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	a := d.agent
	switch ev.Type {
	case "system":
		// The init event (emitted once at startup) lists the session's slash
		// commands. Forward them so the client can offer a typeahead menu.
		if ev.Subtype == "init" && len(ev.SlashCommands) > 0 {
			a.emitAvailableCommands(ev.SlashCommands)
		}
	case "assistant":
		for _, c := range ev.Message.Content {
			switch c.Type {
			case "text":
				if t := strings.TrimSpace(c.Text); t != "" {
					a.emit(acp.AgentMessageChunk{SessionUpdate: acp.UpdateAgentMessageChunk, MessageID: a.curMsgID, Content: acp.TextBlock(t)})
				}
			case "thinking":
				if t := strings.TrimSpace(c.Thinking); t != "" {
					a.emit(acp.AgentThoughtChunk{SessionUpdate: acp.UpdateAgentThoughtChunk, MessageID: a.curMsgID, Content: acp.TextBlock(t)})
				}
			case "tool_use":
				// Reuse Claude's own tool_use id as the ACP toolCallId so the
				// follow-up tool_result (a `user` event) can be matched back to
				// this call via a tool_call_update.
				id := c.ID
				if id == "" {
					id = c.Name + "-" + shortUnique()
				}
				a.emit(acp.ToolCall{
					SessionUpdate: acp.UpdateToolCall,
					ToolCallID:    id,
					Title:         toolSummary(c.Name, c.Input),
					Kind:          toolKind(c.Name),
					Status:        acp.ToolStatusPending,
					RawInput:      c.Input,
				})
			}
		}
	case "user":
		// Claude reports each tool's output as a tool_result block on a `user`
		// event. Forward it as a tool_call_update so the transcript (and the UI)
		// can attach the output — expandable — to the originating tool call.
		for _, c := range ev.Message.Content {
			if c.Type != "tool_result" || c.ToolUseID == "" {
				continue
			}
			status := acp.ToolStatusCompleted
			if c.IsError {
				status = acp.ToolStatusFailed
			}
			up := acp.ToolCallUpdate{
				SessionUpdate: acp.UpdateToolCallUpdate,
				ToolCallID:    c.ToolUseID,
				Status:        status,
			}
			if t := toolResultText(c.ToolResult); t != "" {
				up.Content = []acp.ToolCallContent{{Type: "content", Content: acp.TextBlock(t)}}
			}
			a.emit(up)
		}
	case "result":
		// Accumulate this turn's usage into the session total and re-emit the
		// running total as the token marker. The agent's stderr is teed into the
		// proxy's transcript, so the marker rides the pod log like the one-shot
		// path's.
		if !ev.Usage.empty() {
			a.mu.Lock()
			a.tokens.add(ev.Usage)
			total := a.tokens
			a.mu.Unlock()
			logTokenUsage(total)
		}
		reason := acp.StopEndTurn
		if ev.IsError {
			reason = acp.StopRefusal
		}
		select {
		case d.turnDone <- acp.PromptResult{StopReason: reason}:
		default:
		}
	}
}

func (a *acpAgent) promptClaude(ctx context.Context, text string) (any, error) {
	d := a.claude
	if d == nil {
		return nil, &acp.RPCError{Code: acp.CodeInternalError, Message: "claude session not started"}
	}
	// Drop any stale completion left from a previous turn before sending.
	select {
	case <-d.turnDone:
	default:
	}
	if err := writeUserMessage(d.stdin, text); err != nil {
		return nil, &acp.RPCError{Code: acp.CodeInternalError, Message: "write message: " + err.Error()}
	}
	select {
	case <-ctx.Done():
		return acp.PromptResult{StopReason: acp.StopCancelled}, nil
	case r := <-d.turnDone:
		return r, nil
	}
}

// ── Codex driver (one process per turn) ───────────────────────────────────────

func (a *acpAgent) promptCodex(ctx context.Context, text string) (any, error) {
	resume := a.codexBegun
	prompt := text
	if !resume {
		prompt = foldSystemPrompt(a.sysPrompt, text)
	}
	args := codexArgs(config{model: a.model}, prompt, resume, false)
	cmd := exec.CommandContext(ctx, "codex", args...)
	cmd.Dir = a.workDir
	cmd.Env = buildEnv(a.provider)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, &acp.RPCError{Code: acp.CodeInternalError, Message: err.Error()}
	}
	if err := cmd.Start(); err != nil {
		return nil, &acp.RPCError{Code: acp.CodeInternalError, Message: err.Error()}
	}
	reader := bufio.NewReaderSize(stdout, 1<<20)
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			a.handleCodexEvent(line)
		}
		if readErr != nil {
			break
		}
	}
	waitErr := cmd.Wait()
	a.codexBegun = true
	if ctx.Err() != nil {
		return acp.PromptResult{StopReason: acp.StopCancelled}, nil
	}
	if waitErr != nil {
		return acp.PromptResult{StopReason: acp.StopRefusal}, nil
	}
	return acp.PromptResult{StopReason: acp.StopEndTurn}, nil
}

func (a *acpAgent) handleCodexEvent(raw []byte) {
	var ev codexEvent
	if json.Unmarshal(raw, &ev) != nil || ev.Type != "item.completed" || ev.Item == nil {
		return
	}
	switch ev.Item.Type {
	case "agent_message":
		if t := strings.TrimSpace(ev.Item.Text); t != "" {
			a.emit(acp.AgentMessageChunk{SessionUpdate: acp.UpdateAgentMessageChunk, MessageID: a.curMsgID, Content: acp.TextBlock(t)})
		}
	case "command_execution":
		if c := strings.TrimSpace(ev.Item.Command); c != "" {
			a.emitToolCall("exec", acp.ToolKindExecute, "exec: "+strings.SplitN(c, "\n", 2)[0])
		}
	case "file_change":
		a.emitToolCall("edit", acp.ToolKindEdit, "file change")
	case "web_search":
		if q := strings.TrimSpace(ev.Item.Query); q != "" {
			a.emitToolCall("search", acp.ToolKindFetch, "search: "+q)
		}
	case "mcp_tool_call":
		if n := strings.TrimSpace(ev.Item.Name); n != "" {
			a.emitToolCall("tool", acp.ToolKindOther, "tool: "+n)
		}
	}
}

// emitAvailableCommands forwards the session's slash-command names to the client
// as an available_commands_update. The claude CLI reports only names (no
// descriptions), so the description is left empty for the client to fill.
func (a *acpAgent) emitAvailableCommands(names []string) {
	cmds := make([]acp.AvailableCommand, 0, len(names))
	for _, n := range names {
		if n = strings.TrimSpace(n); n != "" {
			cmds = append(cmds, acp.AvailableCommand{Name: n})
		}
	}
	if len(cmds) == 0 {
		return
	}
	a.emit(acp.AvailableCommandsUpdate{
		SessionUpdate:     acp.UpdateAvailableCommands,
		AvailableCommands: cmds,
	})
}

func (a *acpAgent) emitToolCall(idPrefix, kind, title string) {
	a.emit(acp.ToolCall{
		SessionUpdate: acp.UpdateToolCall,
		ToolCallID:    idPrefix + "-" + shortUnique(),
		Title:         title,
		Kind:          kind,
		Status:        acp.ToolStatusPending,
	})
}

// ── helpers ───────────────────────────────────────────────────────────────────

// promptText concatenates the text content blocks of a prompt into one string.
// Bandolier prompts are plain text, so non-text blocks are ignored.
func promptText(blocks []acp.ContentBlock) string {
	var b strings.Builder
	for _, blk := range blocks {
		if blk.Type == "text" {
			b.WriteString(blk.Text)
		}
	}
	return b.String()
}

// toolKind maps a Claude Code tool name to the nearest ACP tool-call kind.
func toolKind(name string) string {
	switch name {
	case "Bash":
		return acp.ToolKindExecute
	case "Read", "NotebookRead":
		return acp.ToolKindRead
	case "Write", "Edit", "MultiEdit", "NotebookEdit":
		return acp.ToolKindEdit
	case "Grep", "Glob", "LS":
		return acp.ToolKindSearch
	case "WebFetch", "WebSearch":
		return acp.ToolKindFetch
	default:
		return acp.ToolKindOther
	}
}

func getenvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// String renders a providerKind for diagnostics.
func (p providerKind) String() string {
	switch p {
	case providerAnthropic:
		return "anthropic"
	case providerBedrock:
		return "bedrock"
	case providerOpenAI:
		return "openai"
	case providerGemini:
		return "gemini"
	default:
		return "none"
	}
}
