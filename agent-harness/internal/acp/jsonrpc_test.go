package acp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// pipePair wires two Conns together over in-memory pipes, as if they were the
// two ends of a stdio connection.
func pipePair(t *testing.T) (a, b *Conn) {
	t.Helper()
	ar, bw := io.Pipe() // a reads what b writes
	br, aw := io.Pipe() // b reads what a writes
	a = NewConn(ar, aw)
	b = NewConn(br, bw)
	t.Cleanup(func() {
		_ = aw.Close()
		_ = bw.Close()
	})
	return a, b
}

// injectablePair wires a server Conn to a real client Conn (so calls can round
// trip) and returns an inject func that writes raw bytes straight into the
// server's reader, letting tests feed frames the client would never produce.
func injectablePair(t *testing.T) (server, client *Conn, inject func(frame string)) {
	t.Helper()
	serverR, clientW := io.Pipe() // server reads serverR; client (and inject) write clientW
	clientR, serverW := io.Pipe() // client reads clientR; server writes serverW
	server = NewConn(serverR, serverW)
	client = NewConn(clientR, clientW)
	t.Cleanup(func() {
		_ = clientW.Close()
		_ = serverW.Close()
	})
	inject = func(frame string) {
		t.Helper()
		if _, err := clientW.Write([]byte(frame)); err != nil {
			t.Fatalf("inject frame: %v", err)
		}
	}
	return server, client, inject
}

// errReader returns err on every Read, standing in for a transport that fails
// (or, with io.EOF, one that closes cleanly).
type errReader struct{ err error }

func (r errReader) Read([]byte) (int, error) { return 0, r.err }

func TestCallResponse(t *testing.T) {
	client, server := pipePair(t)

	server.Handle("echo", func(_ context.Context, params json.RawMessage) (any, error) {
		var p struct {
			Msg string `json:"msg"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &RPCError{Code: CodeInvalidParams, Message: err.Error()}
		}
		return map[string]string{"reply": "got:" + p.Msg}, nil
	})
	server.Start()
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var out struct {
		Reply string `json:"reply"`
	}
	if err := client.CallResult(ctx, "echo", map[string]string{"msg": "hi"}, &out); err != nil {
		t.Fatalf("call: %v", err)
	}
	if out.Reply != "got:hi" {
		t.Fatalf("reply = %q, want %q", out.Reply, "got:hi")
	}
}

func TestCallError(t *testing.T) {
	client, server := pipePair(t)
	server.Handle("boom", func(context.Context, json.RawMessage) (any, error) {
		return nil, &RPCError{Code: CodeInvalidRequest, Message: "nope"}
	})
	server.Start()
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := client.Call(ctx, "boom", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	rpcErr, ok := err.(*RPCError)
	if !ok || rpcErr.Code != CodeInvalidRequest {
		t.Fatalf("err = %#v, want RPCError code %d", err, CodeInvalidRequest)
	}
}

func TestMethodNotFound(t *testing.T) {
	client, server := pipePair(t)
	server.Start()
	client.Start()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := client.Call(ctx, "missing", nil)
	rpcErr, ok := err.(*RPCError)
	if !ok || rpcErr.Code != CodeMethodNotFound {
		t.Fatalf("err = %#v, want method-not-found", err)
	}
}

func TestNotificationsOrdered(t *testing.T) {
	client, server := pipePair(t)

	const n = 50
	var (
		mu   sync.Mutex
		got  []int
		done = make(chan struct{})
	)
	client.HandleNotification("tick", func(_ context.Context, params json.RawMessage) {
		var p struct {
			Seq int `json:"seq"`
		}
		_ = json.Unmarshal(params, &p)
		mu.Lock()
		got = append(got, p.Seq)
		if len(got) == n {
			close(done)
		}
		mu.Unlock()
	})
	server.Start()
	client.Start()

	for i := 0; i < n; i++ {
		if err := server.Notify("tick", map[string]int{"seq": i}); err != nil {
			t.Fatalf("notify: %v", err)
		}
	}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for notifications")
	}
	mu.Lock()
	defer mu.Unlock()
	for i := 0; i < n; i++ {
		if got[i] != i {
			t.Fatalf("notification %d out of order: got %d", i, got[i])
		}
	}
}

// TestBidirectionalDuringRequest verifies the agent can call back to the client
// while still inside a request handler (the request/permission pattern).
func TestBidirectionalDuringRequest(t *testing.T) {
	client, server := pipePair(t)

	client.Handle("ask", func(context.Context, json.RawMessage) (any, error) {
		return map[string]bool{"ok": true}, nil
	})
	server.Handle("work", func(ctx context.Context, _ json.RawMessage) (any, error) {
		var r struct {
			OK bool `json:"ok"`
		}
		if err := server.CallResult(ctx, "ask", nil, &r); err != nil {
			return nil, err
		}
		return map[string]bool{"done": r.OK}, nil
	})
	server.Start()
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out struct {
		Done bool `json:"done"`
	}
	if err := client.CallResult(ctx, "work", nil, &out); err != nil {
		t.Fatalf("call: %v", err)
	}
	if !out.Done {
		t.Fatal("callback did not round-trip")
	}
}

// TestMalformedFrameReportsErrorAndKeepsGoing feeds a garbage line, then a valid
// call, proving OnError fires for the bad frame and the connection stays usable.
func TestMalformedFrameReportsErrorAndKeepsGoing(t *testing.T) {
	server, client, inject := injectablePair(t)

	errCh := make(chan error, 1)
	server.OnError(func(err error) {
		select {
		case errCh <- err:
		default:
		}
	})
	server.Handle("echo", func(context.Context, json.RawMessage) (any, error) {
		return map[string]bool{"ok": true}, nil
	})
	server.Start()
	client.Start()

	inject("this is not json\n")

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("OnError called with nil error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for OnError")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out struct {
		OK bool `json:"ok"`
	}
	if err := client.CallResult(ctx, "echo", nil, &out); err != nil {
		t.Fatalf("call after malformed frame: %v", err)
	}
	if !out.OK {
		t.Fatal("connection unusable after malformed frame")
	}
}

// TestMalformedFrameNoHandlerDoesNotPanic covers reportErr when OnError is unset:
// a bad frame must be swallowed silently rather than crashing the read loop.
func TestMalformedFrameNoHandlerDoesNotPanic(t *testing.T) {
	server, _, inject := injectablePair(t)
	server.Start()

	inject("{bad\n")
	// Give the read loop a moment to process; a panic would fail the test.
	time.Sleep(50 * time.Millisecond)
}

// TestResponseWithStringIDDropped feeds a well-formed response whose id is a
// string. deliver must ignore non-numeric ids (the proxy relies on this) without
// panicking, and the connection must keep working.
func TestResponseWithStringIDDropped(t *testing.T) {
	server, client, inject := injectablePair(t)

	server.OnError(func(err error) { t.Errorf("unexpected OnError: %v", err) })
	server.Handle("echo", func(context.Context, json.RawMessage) (any, error) {
		return map[string]bool{"ok": true}, nil
	})
	server.Start()
	client.Start()

	inject(`{"jsonrpc":"2.0","id":"proxy-1","result":{"ignored":true}}` + "\n")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out struct {
		OK bool `json:"ok"`
	}
	if err := client.CallResult(ctx, "echo", nil, &out); err != nil {
		t.Fatalf("call after string-id response: %v", err)
	}
	if !out.OK {
		t.Fatal("connection unusable after string-id response")
	}
}

// TestCallOnClosedConnection closes the reader mid-Call so the read loop stops,
// which must unblock the pending Call with "acp: connection closed".
func TestCallOnClosedConnection(t *testing.T) {
	pr, pw := io.Pipe()
	c := NewConn(pr, io.Discard)
	c.Start()

	errCh := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), "hang", nil)
		errCh <- err
	}()

	// Let the Call register its pending entry and send its frame, then kill the
	// reader so <-c.done wins the select.
	time.Sleep(50 * time.Millisecond)
	_ = pw.CloseWithError(errors.New("peer gone"))

	select {
	case err := <-errCh:
		if err == nil || err.Error() != "acp: connection closed" {
			t.Fatalf("err = %v, want %q", err, "acp: connection closed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Call to unblock")
	}
}

// TestCallContextCancelled cancels the context of an in-flight Call (no response
// ever arrives) and expects the context error to surface.
func TestCallContextCancelled(t *testing.T) {
	client, server := pipePair(t)
	server.Handle("hang", func(ctx context.Context, _ json.RawMessage) (any, error) {
		<-ctx.Done() // never returns a result within the test window
		return nil, ctx.Err()
	})
	server.Start()
	client.Start()

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := client.Call(ctx, "hang", nil)
		errCh <- err
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for cancelled Call")
	}
}

// TestWaitPropagatesReadError verifies Wait returns a non-EOF transport error.
func TestWaitPropagatesReadError(t *testing.T) {
	wantErr := errors.New("boom")
	c := NewConn(errReader{err: wantErr}, io.Discard)
	c.Start()

	done := make(chan error, 1)
	go func() { done <- c.Wait() }()

	select {
	case err := <-done:
		if !errors.Is(err, wantErr) {
			t.Fatalf("Wait() = %v, want %v", err, wantErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Wait")
	}
}

// TestWaitNilOnEOF verifies a clean EOF yields a nil terminating error.
func TestWaitNilOnEOF(t *testing.T) {
	c := NewConn(errReader{err: io.EOF}, io.Discard)
	c.Start()

	done := make(chan error, 1)
	go func() { done <- c.Wait() }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Wait() = %v, want nil on EOF", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Wait")
	}
}

// TestCallWriteError surfaces a send failure: when the writer is broken, Call
// must return the write error rather than blocking. The frame is written before
// the response select, so the write error propagates directly.
func TestCallWriteError(t *testing.T) {
	wantErr := errors.New("write failed")
	// A blocking reader keeps the read loop alive so the closed-conn branch can't
	// win; only the write error should surface.
	pr, pw := io.Pipe()
	t.Cleanup(func() { _ = pw.Close() })
	c := NewConn(pr, brokenWriter{err: wantErr})
	c.Start()

	_, err := c.Call(context.Background(), "m", nil)
	if !errors.Is(err, wantErr) {
		t.Fatalf("Call err = %v, want %v", err, wantErr)
	}
}

// brokenWriter fails every Write, standing in for a severed transport.
type brokenWriter struct{ err error }

func (w brokenWriter) Write([]byte) (int, error) { return 0, w.err }
