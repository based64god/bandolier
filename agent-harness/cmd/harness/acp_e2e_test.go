package main

// Real-subprocess end-to-end test for the interactive ACP loop: a genuine
// acpProxy (in this process) driving a genuine serveACPAgent over a real process
// boundary, with a fake claude CLI behind the agent and the fakeBandolier server
// as the frame relay. Where acp_proxy_test.go drives the proxy against a hand-
// written fakeAgent and acp_agent_integration_test.go drives the agent from a
// hand-written client, this exercises both real halves together end to end: the
// handshake, the seed turn, a relay-delivered follow-up turn, and the end-session
// control frame, each crossing the same stdio + HTTP surfaces the pod uses.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// pushedACPFrames returns every agent→client frame the proxy has POSTed to the
// relay so far, flattening the {"frames":[...]} envelopes the harness sends.
func pushedACPFrames(f *fakeBandolier) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.requests {
		if r.method != http.MethodPost || r.path != "/acp" {
			continue
		}
		var body struct {
			Frames []string `json:"frames"`
		}
		if json.Unmarshal(r.body, &body) == nil {
			out = append(out, body.Frames...)
		}
	}
	return out
}

// TestInteractiveACPLoopE2E runs a full interactive session with two real halves
// over a process boundary. The proxy self-execs the test binary as the ACP agent
// (TestMain routes HARNESS_TEST_SUBPROCESS=acp-agent into runACPAgent), the agent
// wraps a fake claude that echoes each turn, and the fakeBandolier server is the
// relay the proxy pushes agent frames to and pulls client frames from.
func TestInteractiveACPLoopE2E(t *testing.T) {
	setAnthropicEnv(t)
	// A fake claude on PATH for the real agent subprocess to wrap; buildFakeClaude
	// skips the test when the go toolchain is unavailable.
	binDir := buildFakeClaude(t)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	workDir := t.TempDir()
	// Set these on the parent so os.Environ() carries exactly one copy each; the
	// child inherits them (matching runACPProxy's agentEnv), with no duplicate
	// keys whose resolution order would be ambiguous.
	t.Setenv("WORKING_DIR", workDir)
	t.Setenv("CLAUDE_MODEL", "claude-sonnet-4-6")
	t.Setenv("CLAUDE_EFFORT", "")
	t.Setenv("ACP_SYSTEM_PROMPT", "")

	// The relay: the proxy pushes agent→client frames to POST /acp and pulls
	// client→agent frames from GET /acp. installFakeBando points the package-wide
	// bando client (used by acpPush/acpPull) at the fake.
	f := newFakeBandolier(t)
	installFakeBando(t, f)
	acpURL := f.srv.URL + "/acp"

	const seedTask = "implement the login feature"

	// Spawn the agent as a subprocess of os.Args[0] — the test binary — exactly as
	// runACPProxy spawns os.Executable(). HARNESS_TEST_SUBPROCESS is set only on
	// the child so the parent's own test run is unaffected.
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "HARNESS_TEST_SUBPROCESS=acp-agent")
	agentStderr := &syncBuffer{}
	cmd.Stderr = agentStderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start acp-agent subprocess: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		if t.Failed() {
			t.Logf("acp-agent subprocess stderr:\n%s", agentStderr.String())
		}
	})

	p := &acpProxy{
		cfg:   config{task: seedTask, workDir: workDir, acpURL: acpURL},
		stdin: stdin,
		ended: make(chan struct{}),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- p.serve(ctx, stdout) }()

	// The handshake + seed turn must complete end to end: the seed task is echoed
	// to the relay as the user's opening turn, the real agent (via the fake claude)
	// produces the answer as an agent_message_chunk pushed to the relay, and the
	// prompt response (stopReason) marks the turn finished.
	waitFor(t, func() bool {
		var sawUserSeed, sawAgentEcho, sawStop bool
		for _, fr := range pushedACPFrames(f) {
			if strings.Contains(fr, "user_message_chunk") && strings.Contains(fr, seedTask) {
				sawUserSeed = true
			}
			if strings.Contains(fr, "agent_message_chunk") && strings.Contains(fr, "echo: "+seedTask) {
				sawAgentEcho = true
			}
			if strings.Contains(fr, "stopReason") {
				sawStop = true
			}
		}
		return sawUserSeed && sawAgentEcho && sawStop
	})

	// A follow-up prompt queued on the relay must reach the agent (pulled by the
	// c2a pump into the subprocess's stdin) and drive another real turn, echoed
	// back as an agent_message_chunk. The sessionId here is arbitrary — the agent
	// keys turns on its own long-lived session, not on the frame's id.
	const followUp = "now add tests"
	f.queueACP(`{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"sess-1","prompt":[{"type":"text","text":"` + followUp + `"}]}}`)
	waitFor(t, func() bool {
		for _, fr := range pushedACPFrames(f) {
			if strings.Contains(fr, "agent_message_chunk") && strings.Contains(fr, "echo: "+followUp) {
				return true
			}
		}
		return false
	})

	// The end-session control frame ends serve; the caller then closes the agent's
	// stdin, and the subprocess must exit cleanly.
	f.queueACP(`{"jsonrpc":"2.0","method":"_bandolier/endSession"}`)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned error: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("serve did not end after the end-session control frame")
	}

	_ = stdin.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatalf("acp-agent subprocess did not exit cleanly: %v\nstderr:\n%s", err, agentStderr.String())
	}
}
