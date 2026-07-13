package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRelay is an in-memory stand-in for the /api/acp endpoint: GET drains the
// queued client→agent frames, POST collects the agent→client frames.
type fakeRelay struct {
	mu    sync.Mutex
	queue []string // c2a, delivered to the proxy on GET
	sink  []string // a2c, pushed by the proxy on POST
}

func (r *fakeRelay) enqueue(frame string) {
	r.mu.Lock()
	r.queue = append(r.queue, frame)
	r.mu.Unlock()
}

func (r *fakeRelay) pushed() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.sink...)
}

func (r *fakeRelay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		r.mu.Lock()
		q := r.queue
		r.queue = nil
		r.mu.Unlock()
		if len(q) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		type frame struct {
			Seq     int    `json:"seq"`
			Payload string `json:"payload"`
		}
		out := struct {
			Frames []frame `json:"frames"`
		}{}
		for i, p := range q {
			out.Frames = append(out.Frames, frame{Seq: i, Payload: p})
		}
		_ = json.NewEncoder(w).Encode(out)
	case http.MethodPost:
		var body struct {
			Frames []string `json:"frames"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		r.mu.Lock()
		r.sink = append(r.sink, body.Frames...)
		r.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// fakeAgent plays the ACP server over the proxy's pipes: it answers the
// handshake, assigns a session id, and for each prompt emits one assistant
// message update followed by an end_turn response.
func fakeAgent(t *testing.T, stdin io.Reader, stdout io.Writer) {
	t.Helper()
	sc := bufio.NewScanner(stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	write := func(v any) {
		b, _ := json.Marshal(v)
		_, _ = stdout.Write(append(b, '\n'))
	}
	for sc.Scan() {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		switch m.Method {
		case "initialize":
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"protocolVersion": 1}})
		case "session/new":
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"sessionId": "sess-1"}})
		case "session/prompt":
			write(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "sess-1",
					"update":    map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "working"}},
				},
			})
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"stopReason": "end_turn"}})
		}
	}
}

func TestACPProxyRelays(t *testing.T) {
	relay := &fakeRelay{}
	srv := httptest.NewServer(relay)
	defer srv.Close()

	agentStdinR, agentStdinW := io.Pipe() // proxy → agent
	agentStdoutR, agentStdoutW := io.Pipe()
	go fakeAgent(t, agentStdinR, agentStdoutW)

	p := &acpProxy{
		cfg:   config{acpURL: srv.URL, workDir: t.TempDir(), task: "build the feature"},
		stdin: agentStdinW,
		ended: make(chan struct{}),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- p.serve(ctx, agentStdoutR) }()

	// Wait until the seed task has been echoed and the agent's reply has been
	// pushed to the relay.
	waitFor(t, func() bool {
		var sawUser, sawAgent bool
		for _, f := range relay.pushed() {
			if strings.Contains(f, "user_message_chunk") && strings.Contains(f, "build the feature") {
				sawUser = true
			}
			if strings.Contains(f, "agent_message_chunk") && strings.Contains(f, "working") {
				sawAgent = true
			}
		}
		return sawUser && sawAgent
	})

	// A frontend follow-up prompt should reach the agent and produce another
	// agent message.
	relay.enqueue(`{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"sess-1","prompt":[{"type":"text","text":"more"}]}}`)
	waitFor(t, func() bool {
		count := 0
		for _, f := range relay.pushed() {
			if strings.Contains(f, "agent_message_chunk") {
				count++
			}
		}
		return count >= 2
	})

	// The end-session control frame should end the session.
	relay.enqueue(`{"jsonrpc":"2.0","method":"_bandolier/endSession"}`)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not end after end-session frame")
	}

	_ = agentStdinW.Close()
	_ = agentStdoutW.Close()
}

// TestACPProxyIdleTimeout drives serve against a fake agent with no queued
// client frames; the c2aPump must end the session once the idle timeout elapses.
func TestACPProxyIdleTimeout(t *testing.T) {
	t.Setenv("INTERACTIVE_IDLE_TIMEOUT", "100ms")

	relay := &fakeRelay{}
	srv := httptest.NewServer(relay)
	defer srv.Close()

	agentStdinR, agentStdinW := io.Pipe()
	agentStdoutR, agentStdoutW := io.Pipe()
	go fakeAgent(t, agentStdinR, agentStdoutW)

	p := &acpProxy{
		cfg:   config{acpURL: srv.URL, workDir: t.TempDir(), task: "build the feature"},
		stdin: agentStdinW,
		ended: make(chan struct{}),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- p.serve(ctx, agentStdoutR) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned error: %v", err)
		}
		if ctx.Err() != nil {
			t.Fatal("serve ended via ctx, not the idle path")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not end via the idle timeout")
	}

	_ = agentStdinW.Close()
	_ = agentStdoutW.Close()
}

// TestACPProxyAgentExit exercises the a2cPump agent-exit branch: when the agent's
// stdout closes, serve must end the session rather than waiting on the idle timeout.
func TestACPProxyAgentExit(t *testing.T) {
	relay := &fakeRelay{}
	srv := httptest.NewServer(relay)
	defer srv.Close()

	agentStdinR, agentStdinW := io.Pipe()
	agentStdoutR, agentStdoutW := io.Pipe()
	go fakeAgent(t, agentStdinR, agentStdoutW)

	p := &acpProxy{
		cfg:   config{acpURL: srv.URL, workDir: t.TempDir(), task: "build the feature"},
		stdin: agentStdinW,
		ended: make(chan struct{}),
	}

	// A long idle timeout so a passing test can only end via the agent-exit path.
	t.Setenv("INTERACTIVE_IDLE_TIMEOUT", "1h")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- p.serve(ctx, agentStdoutR) }()

	// Wait until the seed round-trip completed, then close the agent's stdout to
	// simulate the agent exiting.
	waitFor(t, func() bool {
		for _, f := range relay.pushed() {
			if strings.Contains(f, "agent_message_chunk") {
				return true
			}
		}
		return false
	})
	_ = agentStdoutW.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned error: %v", err)
		}
		if ctx.Err() != nil {
			t.Fatal("serve ended via ctx, not the agent-exit path")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not end after the agent exited")
	}

	_ = agentStdinW.Close()
}

// toggleWriter forwards writes to an inner writer until fail is flipped, after
// which every write errors — lets a test make the c2aPump's stdin write fail
// only after the handshake writes have gone through.
type toggleWriter struct {
	mu   sync.Mutex
	w    io.Writer
	fail bool
}

func (t *toggleWriter) setFail() {
	t.mu.Lock()
	t.fail = true
	t.mu.Unlock()
}

func (t *toggleWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	fail := t.fail
	t.mu.Unlock()
	if fail {
		return 0, io.ErrClosedPipe
	}
	return t.w.Write(p)
}

// TestACPProxyStdinWriteFailure exercises the c2aPump stdin-write-failure branch:
// when forwarding a client frame to the agent fails, serve must end the session.
func TestACPProxyStdinWriteFailure(t *testing.T) {
	t.Setenv("INTERACTIVE_IDLE_TIMEOUT", "1h")

	relay := &fakeRelay{}
	srv := httptest.NewServer(relay)
	defer srv.Close()

	agentStdinR, agentStdinW := io.Pipe()
	agentStdoutR, agentStdoutW := io.Pipe()
	go fakeAgent(t, agentStdinR, agentStdoutW)

	stdin := &toggleWriter{w: agentStdinW}
	p := &acpProxy{
		cfg:   config{acpURL: srv.URL, workDir: t.TempDir(), task: "build the feature"},
		stdin: stdin,
		ended: make(chan struct{}),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- p.serve(ctx, agentStdoutR) }()

	// Let the handshake and seed complete, then make subsequent stdin writes fail
	// and enqueue a client frame the pump will try to forward.
	waitFor(t, func() bool {
		for _, f := range relay.pushed() {
			if strings.Contains(f, "agent_message_chunk") {
				return true
			}
		}
		return false
	})
	stdin.setFail()
	relay.enqueue(`{"jsonrpc":"2.0","id":2,"method":"session/cancel","params":{"sessionId":"sess-1"}}`)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned error: %v", err)
		}
		if ctx.Err() != nil {
			t.Fatal("serve ended via ctx, not the stdin-write-failure path")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not end after the stdin write failed")
	}

	_ = agentStdinW.Close()
	_ = agentStdoutW.Close()
}

func TestFramePromptText(t *testing.T) {
	cases := []struct {
		name, frame, want string
	}{
		{
			name:  "single text block",
			frame: `{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"fix the bug"}]}}`,
			want:  "fix the bug",
		},
		{
			name:  "multiple blocks concatenated",
			frame: `{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"a "},{"type":"text","text":"b"}]}}`,
			want:  "a b",
		},
		{
			name:  "no prompt",
			frame: `{"jsonrpc":"2.0","method":"_bandolier/endSession"}`,
			want:  "",
		},
		{
			name:  "not json",
			frame: "nope",
			want:  "",
		},
	}
	for _, tc := range cases {
		if got := framePromptText(tc.frame); got != tc.want {
			t.Errorf("%s: framePromptText = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestFrameID(t *testing.T) {
	cases := []struct {
		name, frame, want string
	}{
		{"string id", `{"jsonrpc":"2.0","id":"bandolier-new","method":"session/new"}`, "bandolier-new"},
		{"numeric id returns empty", `{"jsonrpc":"2.0","id":7,"method":"session/prompt"}`, ""},
		{"no id", `{"jsonrpc":"2.0","method":"session/update"}`, ""},
		{"invalid json", `not json`, ""},
	}
	for _, tc := range cases {
		if got := frameID([]byte(tc.frame)); got != tc.want {
			t.Errorf("%s: frameID = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestFrameMethod(t *testing.T) {
	cases := []struct {
		name, frame, want string
	}{
		{"session/update", `{"jsonrpc":"2.0","method":"session/update"}`, "session/update"},
		{"end-session control", `{"jsonrpc":"2.0","method":"_bandolier/endSession"}`, "_bandolier/endSession"},
		{"no method (response)", `{"jsonrpc":"2.0","id":1,"result":{}}`, ""},
		{"invalid json", `not json`, ""},
	}
	for _, tc := range cases {
		if got := frameMethod(tc.frame); got != tc.want {
			t.Errorf("%s: frameMethod = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestNewSessionID(t *testing.T) {
	cases := []struct {
		name, frame, want string
	}{
		{"session/new response", `{"jsonrpc":"2.0","id":"bandolier-new","result":{"sessionId":"sess-1"}}`, "sess-1"},
		{"no session id", `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}`, ""},
		{"not a response", `{"jsonrpc":"2.0","method":"session/update"}`, ""},
		{"invalid json", `not json`, ""},
	}
	for _, tc := range cases {
		if got := newSessionID([]byte(tc.frame)); got != tc.want {
			t.Errorf("%s: newSessionID = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestFrameStopReason(t *testing.T) {
	cases := []struct {
		name, frame, want string
	}{
		{"end_turn", `{"jsonrpc":"2.0","id":"bandolier-seed","result":{"stopReason":"end_turn"}}`, "end_turn"},
		{"no stop reason", `{"jsonrpc":"2.0","id":"bandolier-new","result":{"sessionId":"sess-1"}}`, ""},
		{"not a response", `{"jsonrpc":"2.0","method":"session/update"}`, ""},
		{"invalid json", `not json`, ""},
	}
	for _, tc := range cases {
		if got := frameStopReason([]byte(tc.frame)); got != tc.want {
			t.Errorf("%s: frameStopReason = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// TestRenderFrameToTranscript exercises every update kind the renderer switches
// on, plus frames it must ignore. It captures both sinks: agent text goes to
// stdoutTee, while user turns and tool activity go through the log package.
func TestRenderFrameToTranscript(t *testing.T) {
	cases := []struct {
		name       string
		frame      string
		labels     map[string]string // spawn id → label, as recorded from earlier frames
		wantStdout string            // trimmed stdoutTee content
		wantLog    string            // substring expected in the log output ("" = expect empty)
	}{
		{
			name:       "agent_message_chunk to stdout",
			frame:      `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"assistant reply"}}}}`,
			wantStdout: "assistant reply",
		},
		{
			name:       "subagent message chunk is attributed and kept out of stdout",
			frame:      `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","parentToolCallId":"agent1","content":{"type":"text","text":"found it"}}}}`,
			labels:     map[string]string{"agent1": "Agent(Explore): find auth"},
			wantStdout: "",
			wantLog:    "⇉ Agent(Explore): find auth ⟫ found it",
		},
		{
			name:    "subagent thought is logged, never to stdout",
			frame:   `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_thought_chunk","parentToolCallId":"agent1","content":{"type":"text","text":"considering"}}}}`,
			labels:  map[string]string{"agent1": "Agent(Explore): find auth"},
			wantLog: "⇉ Agent(Explore): find auth ⟫ (thinking) considering",
		},
		{
			name:    "subagent tool_call is prefixed with its subagent",
			frame:   `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"sub1","parentToolCallId":"agent1","kind":"read","title":"Read a.go"}}}`,
			labels:  map[string]string{"agent1": "Agent(Explore): find auth"},
			wantLog: "⇉ Agent(Explore): find auth ⟫ → Read a.go",
		},
		{
			name:    "subagent tool_call_update output is prefixed with its subagent",
			frame:   `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","parentToolCallId":"agent1","content":[{"content":{"type":"text","text":"the output"}}]}}}`,
			labels:  map[string]string{"agent1": "Agent(Explore): find auth"},
			wantLog: "⇉ Agent(Explore): find auth ⟫ ← the output",
		},
		{
			name:    "user_message_chunk logged as user input",
			frame:   `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"a follow-up"}}}}`,
			wantLog: "[user] a follow-up",
		},
		{
			name:    "tool_call logs its title",
			frame:   `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","title":"Read file.go"}}}`,
			wantLog: "→ Read file.go",
		},
		{
			name:    "tool_call_update concatenates nested content blocks",
			frame:   `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","content":[{"content":{"type":"text","text":"line one"}},{"content":{"type":"text","text":" more"}}]}}}`,
			wantLog: "← line one more",
		},
		{
			name:  "non session/update frame ignored",
			frame: `{"jsonrpc":"2.0","id":"bandolier-seed","result":{"stopReason":"end_turn"}}`,
		},
		{
			name:  "unknown update kind ignored",
			frame: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"plan"}}}`,
		},
		{
			name:  "invalid json ignored",
			frame: `not json`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			origTee := stdoutTee
			stdoutTee = &out
			defer func() { stdoutTee = origTee }()

			var logBuf bytes.Buffer
			origWriter := log.Writer()
			origFlags := log.Flags()
			log.SetOutput(&logBuf)
			log.SetFlags(0)
			defer func() {
				log.SetOutput(origWriter)
				log.SetFlags(origFlags)
			}()

			labels := tc.labels
			if labels == nil {
				labels = map[string]string{}
			}
			renderFrameToTranscript([]byte(tc.frame), labels)

			if got := strings.TrimSpace(out.String()); got != tc.wantStdout {
				t.Errorf("stdoutTee = %q, want %q", got, tc.wantStdout)
			}
			if tc.wantLog == "" {
				if logBuf.Len() != 0 {
					t.Errorf("log output = %q, want empty", logBuf.String())
				}
			} else if !strings.Contains(logBuf.String(), tc.wantLog) {
				t.Errorf("log output = %q, want to contain %q", logBuf.String(), tc.wantLog)
			}
		})
	}
}

// A subagent spawn frame (kind "subagent", no parent) must record its label so a
// later subagent frame carrying that spawn's id resolves to it, and the spawn's
// own line stays unprefixed (it's a main-agent call). This is the stateful glue
// the mirror needs to attribute a subagent's activity across frames.
func TestRenderFrameRecordsSpawnLabel(t *testing.T) {
	origWriter := log.Writer()
	origFlags := log.Flags()
	log.SetOutput(&bytes.Buffer{})
	log.SetFlags(0)
	defer func() {
		log.SetOutput(origWriter)
		log.SetFlags(origFlags)
	}()

	labels := map[string]string{}
	spawn := `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"agent1","parentToolCallId":"","kind":"subagent","title":"Agent(Explore): find auth"}}}`
	renderFrameToTranscript([]byte(spawn), labels)
	if labels["agent1"] != "Agent(Explore): find auth" {
		t.Fatalf("spawn label = %q, want it recorded", labels["agent1"])
	}

	// A child frame now resolves to that spawn's label without the caller re-supplying it.
	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	child := `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"sub1","parentToolCallId":"agent1","kind":"read","title":"Read a.go"}}}`
	renderFrameToTranscript([]byte(child), labels)
	if !strings.Contains(logBuf.String(), "⇉ Agent(Explore): find auth ⟫ → Read a.go") {
		t.Errorf("child log = %q, want it attributed to the recorded spawn", logBuf.String())
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("condition not met within timeout")
}
