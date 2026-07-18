package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/bandolier/agent-harness/internal/acp"
)

// ── ACP proxy mode ────────────────────────────────────────────────────────────
//
// For interactive sessions the harness runs as a transparent proxy between the
// frontend (the ACP client, reached over HTTP via the acp_frame relay) and the
// in-pod agent (the ACP server, `harness acp-agent`, reached over stdio).
//
// The proxy owns session establishment so the agent starts working the moment
// the pod runs, rather than waiting for a browser: it performs initialize +
// session/new and seeds the first prompt (the deploy task / issue message). It
// then relays the live session — every agent→client frame is pushed to the relay
// for the browser to render, and every browser→agent frame (follow-up prompts,
// cancels, the end-session control frame) is pulled from the relay into the
// agent's stdin. The browser attaches to the running session: it reads the
// sessionId from the forwarded session/update frames and drives follow-up turns.

// Bandolier control method: a frontend-originated frame the proxy consumes
// rather than forwarding, ending the session (the harness then runs its post-run
// PR/issue step). It mirrors the old end-session sentinel.
const endSessionMethod = "_bandolier/endSession"

// JSON-RPC ids the proxy uses for the frames it injects on the agent's behalf.
// They are strings so they can never collide with the frontend client's numeric
// ids (whose responses the browser matches); the browser ignores responses to
// these ids.
const (
	seedNewID    = "bandolier-new"
	seedPromptID = "bandolier-seed"
)

// runACPProxy drives an interactive session over ACP: it spawns the agent
// server, seeds the task, and relays frames between the agent and the frontend
// until the session ends (end-session control frame, idle timeout, or
// cancellation). It returns once the agent has exited, so the caller can run the
// post-run PR/issue step.
func runACPProxy(ctx context.Context, cfg config) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve harness executable: %w", err)
	}

	sysPrompt := cfg.withRepoPrompt(cfg.systemPrompt)
	if sysPrompt != "" {
		log.Printf("[harness] system prompt:")
		for _, line := range strings.Split(sysPrompt, "\n") {
			log.Printf("[harness]   %s", line)
		}
	}
	log.Printf("[harness] interactive mode via ACP (provider=%s model=%s)", cfg.provider, cfg.model)

	agentEnv := append(os.Environ(),
		"ACP_SYSTEM_PROMPT="+sysPrompt,
		"CLAUDE_MODEL="+cfg.model,
		// Pass the normalized effort so the agent doesn't re-validate the raw env.
		"CLAUDE_EFFORT="+cfg.effort,
		"WORKING_DIR="+cfg.workDir,
	)
	cmd := exec.CommandContext(ctx, exe, "acp-agent")
	cmd.Dir = cfg.workDir
	cmd.Env = agentEnv
	cmd.Stderr = &prefixWriter{} // agent diagnostics → [harness] (and transcript)
	// Own process group so a pod-termination SIGTERM to the harness's group can't
	// kill the agent (and its claude child, which exits 143 on SIGTERM) directly.
	// Only the harness receives that signal, so it alone drives shutdown: on a
	// normal session end the stdin close below lets the agent exit cleanly, and on
	// ctx cancellation CommandContext tears it down with SIGKILL — either way the
	// harness decides, rather than the runtime killing the agent mid-run.
	cmd.SysProcAttr = ownProcessGroup
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	p := &acpProxy{cfg: cfg, stdin: stdin, ended: make(chan struct{}), subagentLabels: map[string]string{}}
	serveErr := p.serve(ctx, stdout)

	// Closing stdin tells the agent (and its underlying CLI) to exit; then the
	// caller runs the post-run PR/issue step.
	_ = stdin.Close()
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return nil
	}
	if serveErr != nil {
		return serveErr
	}
	return waitErr
}

// serve performs the ACP handshake on the agent, runs the relay pumps, and
// blocks until the session ends (end-session control frame, the agent exiting,
// the idle timeout, or ctx cancellation). It does not close stdin — the caller
// owns the agent process lifecycle. Split from runACPProxy so tests can drive it
// against a fake agent and relay.
func (p *acpProxy) serve(ctx context.Context, stdout io.Reader) error {
	// Start reading the agent before writing the handshake: the agent's responses
	// must have a reader, or it blocks writing them and never reads our requests.
	go p.a2cPump(ctx, stdout)

	// Begin the handshake; session/new's response (seen by the a2c pump) triggers
	// the seed prompt.
	if err := writeFrame(p.stdin, "bandolier-init", "initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{},
	}); err != nil {
		return err
	}
	if err := writeFrame(p.stdin, seedNewID, "session/new", map[string]any{
		"cwd":        p.cfg.workDir,
		"mcpServers": []any{},
	}); err != nil {
		return err
	}

	go p.c2aPump(ctx)

	select {
	case <-ctx.Done():
	case <-p.ended:
	}
	return nil
}

type acpProxy struct {
	cfg       config
	stdin     io.Writer
	sessionID string

	// subagentLabels maps a subagent spawn's tool-call id to its human label,
	// recorded when the spawn frame passes through so the subagent's later frames
	// (which carry that id as their parentToolCallId) can be attributed to it in
	// the mirrored transcript — the interactive counterpart to the one-shot log
	// sink's `labels`. Only the single a2cPump goroutine touches it, so no lock.
	subagentLabels map[string]string

	endOnce sync.Once
	ended   chan struct{}
}

func (p *acpProxy) endSession() { p.endOnce.Do(func() { close(p.ended) }) }

// a2cPump reads frames from the agent, pushes them to the relay for the
// frontend, and renders assistant text into the transcript. It also watches for
// the seed session/new response to capture the sessionId and send the seed
// prompt.
func (p *acpProxy) a2cPump(ctx context.Context, stdout io.Reader) {
	forEachLine(stdout, func(line []byte) { p.handleAgentFrame(ctx, bytes.TrimSpace(line)) })
	// The agent exited (or the stream broke): end the session so the caller can
	// run its post-run step rather than waiting on the idle timeout.
	p.endSession()
}

func (p *acpProxy) handleAgentFrame(ctx context.Context, frame []byte) {
	// Capture the sessionId from the seed session/new response and kick off the
	// seed prompt. This frame is also forwarded (the browser ignores responses to
	// the proxy's ids).
	if id := frameID(frame); id == seedNewID {
		if sid := newSessionID(frame); sid != "" {
			p.sessionID = sid
			p.seedPrompt()
		}
	}

	// A prompt response (stopReason) means the agent finished its turn and is now
	// awaiting the next user message. Emitting the await marker keeps the
	// dashboard's server-side awaiting detection (and the overview/notifications)
	// working without the frontend needing to parse turn state.
	if frameStopReason(frame) != "" {
		log.Printf("[harness] %s", awaitInputMarker)
	}

	renderFrameToTranscript(frame, p.subagentLabels)
	if err := p.acpPush(ctx, string(frame)); err != nil {
		log.Printf("[harness] warn: acp push: %v", err)
	}
}

// seedPrompt sends the initial task to the agent and shows it to the frontend as
// the user's first message.
func (p *acpProxy) seedPrompt() {
	task := p.cfg.task
	if task == "" {
		return
	}
	// Render the seed in the frontend as the user's opening turn.
	if err := p.acpPush(context.Background(), userMessageFrame(p.sessionID, task)); err != nil {
		log.Printf("[harness] warn: acp push (seed echo): %v", err)
	}
	log.Printf("[harness] %s", resumeMarker)
	if err := writeFrame(p.stdin, seedPromptID, "session/prompt", map[string]any{
		"sessionId": p.sessionID,
		"prompt":    []map[string]any{{"type": "text", "text": task}},
	}); err != nil {
		log.Printf("[harness] warn: seed prompt write: %v", err)
	}
}

// c2aPump polls the relay for frontend frames and forwards them to the agent,
// intercepting the end-session control frame. It ends the session if no client
// activity arrives within the idle timeout.
func (p *acpProxy) c2aPump(ctx context.Context) {
	// However pollLoop ends — ctx cancellation, the idle timeout, an end-session
	// frame, or a fatal stdin write — the session is over, so make sure serve
	// unblocks (endSession is idempotent).
	defer p.endSession()
	pollLoop(ctx, "client activity", interactiveIdleTimeout(), func(ctx context.Context) (bool, bool) {
		frames, err := p.acpPull(ctx)
		if err != nil {
			log.Printf("[harness] warn: acp pull: %v", err)
		}
		for _, f := range frames {
			switch frameMethod(f) {
			case endSessionMethod:
				log.Printf("[harness] received end-session control frame")
				p.endSession()
				return false, true
			case "session/prompt":
				// A follow-up turn is starting; mirror the resume marker so the
				// dashboard's awaiting detection flips back to "working".
				log.Printf("[harness] %s", resumeMarker)
				// Mirror the user's message into the transcript (as the legacy
				// input loop does), so the persisted transcript carries both
				// sides of the conversation — the agent never echoes user turns.
				if t := framePromptText(f); t != "" {
					logUserInput(t)
				}
			}
			if _, err := p.stdin.Write(append([]byte(f), '\n')); err != nil {
				log.Printf("[harness] warn: agent stdin write: %v", err)
				p.endSession()
				return false, true
			}
		}
		return len(frames) > 0, false
	}, p.ended)
}

// ── relay HTTP ────────────────────────────────────────────────────────────────

func (p *acpProxy) acpPull(ctx context.Context) ([]string, error) {
	if p.cfg.acpURL == "" {
		return nil, fmt.Errorf("no ACP relay URL configured")
	}
	var body struct {
		Frames []struct {
			Payload string `json:"payload"`
		} `json:"frames"`
	}
	ok, err := bando.getJSON(ctx, "acp pull", p.cfg.acpURL, &body)
	if err != nil || !ok {
		return nil, err
	}
	out := make([]string, 0, len(body.Frames))
	for _, f := range body.Frames {
		out = append(out, f.Payload)
	}
	return out, nil
}

func (p *acpProxy) acpPush(ctx context.Context, frame string) error {
	if p.cfg.acpURL == "" {
		return fmt.Errorf("no ACP relay URL configured")
	}
	body, err := json.Marshal(map[string][]string{"frames": {frame}})
	if err != nil {
		return err
	}
	resp, err := bando.post(ctx, p.cfg.acpURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("acp push status %d", resp.StatusCode)
	}
	return nil
}

// ── frame helpers ─────────────────────────────────────────────────────────────

func writeFrame(w io.Writer, id any, method string, params any) error {
	m := map[string]any{"jsonrpc": "2.0", "method": method}
	if id != nil {
		m["id"] = id
	}
	if params != nil {
		m["params"] = params
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

// userMessageFrame builds a session/update notification that shows text as the
// user's turn in the frontend.
func userMessageFrame(sessionID, text string) string {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "session/update",
		"params": map[string]any{
			"sessionId": sessionID,
			"update": map[string]any{
				"sessionUpdate": acp.UpdateUserMessageChunk,
				"content":       map[string]any{"type": "text", "text": text},
			},
		},
	})
	return string(b)
}

func frameID(raw []byte) string {
	var m struct {
		ID json.RawMessage `json:"id"`
	}
	if json.Unmarshal(raw, &m) != nil || len(m.ID) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(m.ID, &s) == nil {
		return s
	}
	return ""
}

func frameMethod(raw string) string {
	var m struct {
		Method string `json:"method"`
	}
	_ = json.Unmarshal([]byte(raw), &m)
	return m.Method
}

// framePromptText concatenates the text blocks of a session/prompt frame, so
// the user's turn can be rendered into the transcript.
func framePromptText(raw string) string {
	var m struct {
		Params struct {
			Prompt []struct {
				Text string `json:"text"`
			} `json:"prompt"`
		} `json:"params"`
	}
	_ = json.Unmarshal([]byte(raw), &m)
	var b strings.Builder
	for _, p := range m.Params.Prompt {
		b.WriteString(p.Text)
	}
	return b.String()
}

func newSessionID(raw []byte) string {
	var m struct {
		Result struct {
			SessionID string `json:"sessionId"`
		} `json:"result"`
	}
	_ = json.Unmarshal(raw, &m)
	return m.Result.SessionID
}

func frameStopReason(raw []byte) string {
	var m struct {
		Result struct {
			StopReason string `json:"stopReason"`
		} `json:"result"`
	}
	_ = json.Unmarshal(raw, &m)
	return m.Result.StopReason
}

// renderFrameToTranscript mirrors assistant text and tool activity from the
// agent's session/update frames into the pod log / transcript, so issue-output
// mode and PR-copy generation (which read the transcript) keep working. Subagent
// frames (tagged with their spawn's parentToolCallId) are attributed to the
// subagent — using the label recorded in `labels` when the spawn passed through —
// so the mirrored transcript reads like the one-shot log sink: a subagent's
// narration, thinking, tool calls, and output fold into that subagent's block,
// and only the main agent's answer reaches stdoutTee. `labels` is read and
// written here; pass a nil map for a stateless render (subagents fall back to a
// generic label).
func renderFrameToTranscript(raw []byte, labels map[string]string) {
	var m struct {
		Method string `json:"method"`
		Params struct {
			Update json.RawMessage `json:"update"`
		} `json:"params"`
	}
	if json.Unmarshal(raw, &m) != nil || m.Method != "session/update" {
		return
	}
	// `content` differs by update kind — an object {text} for message chunks, an
	// array of blocks for tool_call_update — so switch on the discriminator
	// before decoding it into the shape that variant expects.
	switch acp.UpdateKind(m.Params.Update) {
	case acp.UpdateToolCallUpdate:
		var tu struct {
			ParentToolCallID string `json:"parentToolCallId"`
			Content          []struct {
				Content struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"content"`
		}
		if json.Unmarshal(m.Params.Update, &tu) != nil {
			return
		}
		var b strings.Builder
		for _, c := range tu.Content {
			b.WriteString(c.Content.Text)
		}
		// A subagent's tool output folds into its subagent block; main-agent output
		// stays unprefixed (the parentToolCallId ⇒ prefix mapping is shared with the
		// one-shot path via subagentLinePrefix).
		logToolResult(subagentPrefixFor(labels, tu.ParentToolCallID), b.String())
	default:
		var u struct {
			SessionUpdate    string `json:"sessionUpdate"`
			ToolCallID       string `json:"toolCallId"`
			Title            string `json:"title"`
			Kind             string `json:"kind"`
			ParentToolCallID string `json:"parentToolCallId"`
			Content          struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(m.Params.Update, &u) != nil {
			return
		}
		switch u.SessionUpdate {
		case acp.UpdateAgentMessageChunk:
			t := strings.TrimSpace(u.Content.Text)
			if t == "" {
				break
			}
			// A subagent's narration isn't the run's answer — fold it into the
			// [harness] transcript, attributed to the subagent so distinct subagents
			// stay separate and it doesn't pollute the output used for PR-copy /
			// issue generation. Main-agent text surfaces as before.
			if u.ParentToolCallID != "" {
				prefix := subagentPrefixFor(labels, u.ParentToolCallID)
				for _, l := range strings.Split(t, "\n") {
					log.Printf("[harness] %s%s", prefix, l)
				}
				break
			}
			fmt.Fprintln(stdoutTee, t)
		case acp.UpdateAgentThoughtChunk:
			// Thinking is context, never the run's answer: always [harness]-tagged
			// (never stdoutTee), attributed to the subagent when it came from one.
			// Mirrors the one-shot onThinking format so both transcript paths match.
			t := strings.TrimSpace(u.Content.Text)
			if t == "" {
				break
			}
			prefix := subagentPrefixFor(labels, u.ParentToolCallID)
			lines := strings.Split(t, "\n")
			log.Printf("[harness] %s(thinking) %s", prefix, lines[0])
			for _, l := range lines[1:] {
				log.Printf("[harness] %s    %s", prefix, l)
			}
		case acp.UpdateUserMessageChunk:
			if t := strings.TrimSpace(u.Content.Text); t != "" {
				logUserInput(t)
			}
		case acp.UpdateToolCall:
			// Record a subagent spawn's label so the subagent's later frames (which
			// carry this call's id as their parentToolCallId) can be attributed to
			// it — the mirror's equivalent of the one-shot sink's s.labels.
			if u.Kind == acp.ToolKindSubagent && u.ParentToolCallID == "" && u.ToolCallID != "" && labels != nil {
				labels[u.ToolCallID] = u.Title
			}
			if u.Title != "" {
				// A subagent's own tool call folds into its subagent block; the spawn
				// itself and every other main-agent call stay unprefixed.
				log.Printf("[harness] %s→ %s", subagentPrefixFor(labels, u.ParentToolCallID), u.Title)
			}
		}
	}
}

// subagentPrefixFor resolves the ⇉ <label> ⟫ prefix for a frame tagged with a
// subagent spawn's id, or "" for a main-agent frame (empty parentToolCallId). The
// label comes from the remembered spawn; an unknown id falls back to the generic
// label inside subagentLinePrefix.
func subagentPrefixFor(labels map[string]string, parentToolCallID string) string {
	if parentToolCallID == "" {
		return ""
	}
	return subagentLinePrefix(labels[parentToolCallID])
}
