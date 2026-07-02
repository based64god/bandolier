package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
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
