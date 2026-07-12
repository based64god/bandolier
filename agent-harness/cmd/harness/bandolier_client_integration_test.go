package main

// Integration tests for the harness↔Bandolier HTTP contract. A single
// fakeBandolier server backs all four callbacks (transcript ingest, ACP relay
// push/pull, input poll) and records what the harness actually sends, so these
// assert the exact frame shapes and headers the TypeScript server parses —
// today only the response status is checked. A companion test asserts the
// harness emits the log markers pinned in wire-contract.json at their real emit
// sites (not just that the in-code constants match the file, which
// wire_contract_test.go already covers).

import (
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
)

// recordedReq is one request the fake Bandolier server received.
type recordedReq struct {
	method  string
	path    string
	headers http.Header
	body    []byte
}

// fakeBandolier multiplexes the four callback endpoints the harness talks to,
// recording every request and serving queued frames/messages on the poll
// endpoints. Install it by swapping the package `bando` global at the fake's URL.
type fakeBandolier struct {
	srv *httptest.Server

	mu         sync.Mutex
	requests   []recordedReq
	acpQueue   []string
	inputQueue []string
}

func newFakeBandolier(t *testing.T) *fakeBandolier {
	t.Helper()
	f := &fakeBandolier{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ingest", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("POST /acp", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /acp", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		f.mu.Lock()
		frames := f.acpQueue
		f.acpQueue = nil
		f.mu.Unlock()
		if len(frames) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		type payloadFrame struct {
			Payload string `json:"payload"`
		}
		out := struct {
			Frames []payloadFrame `json:"frames"`
		}{}
		for _, fr := range frames {
			out.Frames = append(out.Frames, payloadFrame{Payload: fr})
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("GET /input", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.inputQueue) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		msg := f.inputQueue[0]
		f.inputQueue = f.inputQueue[1:]
		_ = json.NewEncoder(w).Encode(map[string]string{"content": msg})
	})
	mux.HandleFunc("GET /context", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		_, _ = io.WriteString(w, "parent transcript")
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeBandolier) record(r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.requests = append(f.requests, recordedReq{
		method:  r.Method,
		path:    r.URL.Path,
		headers: r.Header.Clone(),
		body:    body,
	})
	f.mu.Unlock()
}

func (f *fakeBandolier) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = nil
	f.acpQueue = nil
	f.inputQueue = nil
}

func (f *fakeBandolier) queueACP(frame string) {
	f.mu.Lock()
	f.acpQueue = append(f.acpQueue, frame)
	f.mu.Unlock()
}

func (f *fakeBandolier) queueInput(msg string) {
	f.mu.Lock()
	f.inputQueue = append(f.inputQueue, msg)
	f.mu.Unlock()
}

// lastRequest returns the most recent recorded request to path, failing if none.
func (f *fakeBandolier) lastRequest(t *testing.T, method, path string) recordedReq {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.requests) - 1; i >= 0; i-- {
		if f.requests[i].method == method && f.requests[i].path == path {
			return f.requests[i]
		}
	}
	t.Fatalf("no %s %s request recorded (saw %d requests)", method, path, len(f.requests))
	return recordedReq{}
}

// installFakeBando swaps the process-wide bando client to point at the fake and
// restores it on cleanup.
func installFakeBando(t *testing.T, f *fakeBandolier) {
	t.Helper()
	orig := bando
	bando = &bandolierClient{token: "tok-abc", job: "job-42", http: f.srv.Client()}
	t.Cleanup(func() { bando = orig })
}

// assertAuthHeaders checks the two headers every callback carries.
func assertAuthHeaders(t *testing.T, req recordedReq) {
	t.Helper()
	if got := req.headers.Get("Authorization"); got != "Bearer tok-abc" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer tok-abc")
	}
	if got := req.headers.Get("X-Bandolier-Job"); got != "job-42" {
		t.Errorf("X-Bandolier-Job = %q, want %q", got, "job-42")
	}
}

func TestBandolierCallbackConformance(t *testing.T) {
	f := newFakeBandolier(t)
	installFakeBando(t, f)

	t.Run("transcript ingest carries the full header set and body", func(t *testing.T) {
		f.reset()
		t.Setenv("BANDOLIER_INGEST_URL", f.srv.URL+"/ingest")

		origTranscript, origPR := transcript, outputPRURL
		t.Cleanup(func() { transcript, outputPRURL = origTranscript, origPR })

		wantBody := `[harness] work happened` + "\n" +
			`[harness] BANDOLIER_TOKENS={"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}` + "\n"
		transcript = &syncBuffer{}
		_, _ = transcript.Write([]byte(wantBody))
		outputPRURL = "https://github.com/o/r/pull/7"

		uploadTranscript(false)

		req := f.lastRequest(t, http.MethodPost, "/ingest")
		assertAuthHeaders(t, req)
		if got := req.headers.Get("X-Bandolier-Harness-Contract"); got != "1" {
			t.Errorf("X-Bandolier-Harness-Contract = %q, want %q", got, "1")
		}
		if got := req.headers.Get("X-Bandolier-Status"); got != "Succeeded" {
			t.Errorf("X-Bandolier-Status = %q, want Succeeded", got)
		}
		if got := req.headers.Get("X-Bandolier-PR-URL"); got != "https://github.com/o/r/pull/7" {
			t.Errorf("X-Bandolier-PR-URL = %q", got)
		}
		if got := req.headers.Get("X-Bandolier-Tokens"); got != `{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}` {
			t.Errorf("X-Bandolier-Tokens = %q", got)
		}
		if !strings.HasPrefix(req.headers.Get("Content-Type"), "text/plain") {
			t.Errorf("Content-Type = %q, want text/plain", req.headers.Get("Content-Type"))
		}
		if string(req.body) != wantBody {
			t.Errorf("ingest body = %q, want the transcript verbatim %q", req.body, wantBody)
		}
	})

	t.Run("acp push posts the frame envelope with auth headers", func(t *testing.T) {
		f.reset()
		p := &acpProxy{cfg: config{acpURL: f.srv.URL + "/acp"}}
		frame := `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}`
		if err := p.acpPush(context.Background(), frame); err != nil {
			t.Fatalf("acpPush: %v", err)
		}
		req := f.lastRequest(t, http.MethodPost, "/acp")
		assertAuthHeaders(t, req)
		var body struct {
			Frames []string `json:"frames"`
		}
		if err := json.Unmarshal(req.body, &body); err != nil {
			t.Fatalf("push body not {frames:[...]}: %v (%s)", err, req.body)
		}
		if len(body.Frames) != 1 || body.Frames[0] != frame {
			t.Errorf("push frames = %v, want [%q]", body.Frames, frame)
		}
	})

	t.Run("acp pull decodes payloads and treats 204 as empty", func(t *testing.T) {
		f.reset()
		want := `{"jsonrpc":"2.0","method":"session/prompt","params":{"sessionId":"s1"}}`
		f.queueACP(want)
		p := &acpProxy{cfg: config{acpURL: f.srv.URL + "/acp"}}
		frames, err := p.acpPull(context.Background())
		if err != nil {
			t.Fatalf("acpPull: %v", err)
		}
		if len(frames) != 1 || frames[0] != want {
			t.Errorf("pulled frames = %v, want [%q]", frames, want)
		}
		// Queue drained → the next pull sees 204 → no frames, no error.
		frames, err = p.acpPull(context.Background())
		if err != nil {
			t.Fatalf("second acpPull: %v", err)
		}
		if len(frames) != 0 {
			t.Errorf("second pull frames = %v, want empty (204)", frames)
		}
		req := f.lastRequest(t, http.MethodGet, "/acp")
		assertAuthHeaders(t, req)
	})

	t.Run("input poll decodes content and treats 204 as empty", func(t *testing.T) {
		f.reset()
		f.queueInput("hello there")
		cfg := config{inputURL: f.srv.URL + "/input"}
		msg, ok, err := pollInput(context.Background(), cfg)
		if err != nil || !ok || msg != "hello there" {
			t.Fatalf("pollInput = (%q, %v, %v), want (\"hello there\", true, nil)", msg, ok, err)
		}
		_, ok, err = pollInput(context.Background(), cfg)
		if err != nil || ok {
			t.Fatalf("drained pollInput = (ok=%v, err=%v), want (false, nil) on 204", ok, err)
		}
		req := f.lastRequest(t, http.MethodGet, "/input")
		assertAuthHeaders(t, req)
	})
}

// captureLog swaps the log package's output to a buffer for the duration of fn
// and returns what was written.
func captureLog(fn func()) string {
	var buf syncBuffer
	orig := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(orig)
	fn()
	return buf.String()
}

// TestWireContractEmissionConformance asserts the harness emits the pinned wire
// markers at their real emit sites, using the literals from wire-contract.json —
// catching emit-site drift (a hardcoded string that diverged from the constant)
// that the constant-vs-file check in wire_contract_test.go cannot see.
func TestWireContractEmissionConformance(t *testing.T) {
	c := loadWireContract(t)

	// 1. logTokenUsage emits tokenMarkerPrefix + flat JSON that round-trips.
	out := captureLog(func() { logTokenUsage(tokenUsage{InputTokens: 5, OutputTokens: 2}) })
	if !strings.Contains(out, c.TokenMarkerPrefix) {
		t.Errorf("token marker %q not emitted; got %q", c.TokenMarkerPrefix, out)
	}
	marker := latestTokenMarker(out)
	var parsed tokenUsage
	if err := json.Unmarshal([]byte(marker), &parsed); err != nil {
		t.Errorf("token marker payload %q is not flat JSON: %v", marker, err)
	} else if parsed.InputTokens != 5 || parsed.OutputTokens != 2 {
		t.Errorf("token marker round-trip = %+v, want {5,2,...}", parsed)
	}

	// 2. The a2c pump logs awaitInputMarker when a turn finishes (stopReason set).
	out = captureLog(func() {
		p := &acpProxy{cfg: config{}} // no relay URL: acpPush just warns
		p.handleAgentFrame(context.Background(), []byte(`{"id":9,"result":{"stopReason":"end_turn"}}`))
	})
	if !strings.Contains(out, c.AwaitInputMarker) {
		t.Errorf("await marker %q not emitted on turn completion; got %q", c.AwaitInputMarker, out)
	}

	// 3. Seeding the first prompt logs resumeMarker (mirrored again by the c2a
	// pump on follow-up turns).
	f := newFakeBandolier(t)
	installFakeBando(t, f)
	var stdin bytes.Buffer
	out = captureLog(func() {
		p := &acpProxy{cfg: config{task: "do the thing", acpURL: f.srv.URL + "/acp"}, stdin: &stdin, sessionID: "sess-1"}
		p.seedPrompt()
	})
	if !strings.Contains(out, c.ResumeMarker) {
		t.Errorf("resume marker %q not emitted on seed; got %q", c.ResumeMarker, out)
	}
	// The seed prompt frame reached the agent's stdin.
	if !bytes.Contains(stdin.Bytes(), []byte(`"session/prompt"`)) {
		t.Errorf("seed prompt frame not written to agent stdin; got %q", stdin.String())
	}

	// 4. The contract version the harness reports is the pinned literal.
	if harnessContractVersion != c.HarnessContractVersion {
		t.Errorf("harnessContractVersion = %d, contract = %d", harnessContractVersion, c.HarnessContractVersion)
	}
}
