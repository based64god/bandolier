package acp

import (
	"context"
	"encoding/json"
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
