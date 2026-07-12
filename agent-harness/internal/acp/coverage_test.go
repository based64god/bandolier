package acp

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// TestCovTextBlock verifies TextBlock builds a text content block carrying the
// given string and marshals to the expected wire shape.
func TestCovTextBlock(t *testing.T) {
	b := TextBlock("hello world")
	if b.Type != "text" {
		t.Fatalf("Type = %q, want %q", b.Type, "text")
	}
	if b.Text != "hello world" {
		t.Fatalf("Text = %q, want %q", b.Text, "hello world")
	}
	// The other fields must stay zero so they omitempty away on the wire.
	if b.Data != "" || b.MimeType != "" || b.URI != "" || b.Resource != nil {
		t.Fatalf("non-text fields set: %#v", b)
	}
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(raw), `{"type":"text","text":"hello world"}`; got != want {
		t.Fatalf("marshal = %s, want %s", got, want)
	}
}

// TestCovUpdateKind checks the sessionUpdate discriminator extraction across a
// present field, an object without it, and malformed JSON (error swallowed).
func TestCovUpdateKind(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"present", `{"sessionUpdate":"tool_call","toolCallId":"tc-1"}`, UpdateToolCall},
		{"absent", `{"foo":"bar","toolCallId":"tc-1"}`, ""},
		{"malformed", `{not valid json`, ""},
		{"emptyValue", `{"sessionUpdate":""}`, ""},
		{"chunk", `{"sessionUpdate":"agent_message_chunk"}`, UpdateAgentMessageChunk},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := UpdateKind(json.RawMessage(tc.raw)); got != tc.want {
				t.Fatalf("UpdateKind(%s) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestCovRPCErrorError verifies the *RPCError Error() formatting.
func TestCovRPCErrorError(t *testing.T) {
	e := &RPCError{Code: CodeInvalidParams, Message: "bad params"}
	if got, want := e.Error(), "jsonrpc error -32602: bad params"; got != want {
		t.Fatalf("Error() = %q, want %q", got, want)
	}
	// A different code/message to prove both fields are interpolated, not hard-coded.
	e2 := &RPCError{Code: CodeInternalError, Message: "boom"}
	if got, want := e2.Error(), "jsonrpc error -32603: boom"; got != want {
		t.Fatalf("Error() = %q, want %q", got, want)
	}
}

// TestCovMarshalParams exercises all three branches of marshalParams: nil in,
// nil out; a json.RawMessage passed through verbatim (even invalid JSON, which
// json.Marshal would reject — proving the short-circuit); and a struct that is
// JSON-marshalled.
func TestCovMarshalParams(t *testing.T) {
	// nil -> (nil, nil)
	raw, err := marshalParams(nil)
	if err != nil {
		t.Fatalf("marshalParams(nil) err = %v", err)
	}
	if raw != nil {
		t.Fatalf("marshalParams(nil) raw = %q, want nil", raw)
	}

	// json.RawMessage passes through verbatim without re-marshaling. Deliberately
	// invalid JSON: json.Marshal(json.RawMessage(...)) would error, so a nil error
	// with identical bytes proves the type-assert short-circuit was taken.
	verbatim := json.RawMessage(`{not marshalable as-is}`)
	raw, err = marshalParams(verbatim)
	if err != nil {
		t.Fatalf("marshalParams(RawMessage) err = %v", err)
	}
	if string(raw) != string(verbatim) {
		t.Fatalf("marshalParams(RawMessage) = %s, want verbatim %s", raw, verbatim)
	}

	// struct -> JSON.
	type covParams struct {
		X int    `json:"x"`
		Y string `json:"y"`
	}
	raw, err = marshalParams(covParams{X: 7, Y: "z"})
	if err != nil {
		t.Fatalf("marshalParams(struct) err = %v", err)
	}
	if got, want := string(raw), `{"x":7,"y":"z"}`; got != want {
		t.Fatalf("marshalParams(struct) = %s, want %s", got, want)
	}
}

// TestCovCallResultNilOut covers CallResult's out==nil branch: the response is
// received but not unmarshalled, so the call succeeds with a nil error even
// though the handler returns a body.
func TestCovCallResultNilOut(t *testing.T) {
	client, server := pipePair(t)
	server.Handle("noout", func(context.Context, json.RawMessage) (any, error) {
		return map[string]string{"reply": "ignored"}, nil
	})
	server.Start()
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.CallResult(ctx, "noout", nil, nil); err != nil {
		t.Fatalf("CallResult with nil out: %v", err)
	}
}

// TestCovCallResultDecode covers CallResult's out!=nil branch: the result is
// decoded into the provided struct.
func TestCovCallResultDecode(t *testing.T) {
	client, server := pipePair(t)
	server.Handle("give", func(context.Context, json.RawMessage) (any, error) {
		return map[string]int{"n": 42}, nil
	})
	server.Start()
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out struct {
		N int `json:"n"`
	}
	if err := client.CallResult(ctx, "give", nil, &out); err != nil {
		t.Fatalf("CallResult decode: %v", err)
	}
	if out.N != 42 {
		t.Fatalf("out.N = %d, want 42", out.N)
	}
}

// TestCovNotify verifies Notify delivers a one-way notification (no response)
// that the peer's registered NotificationHandler receives, with its params.
func TestCovNotify(t *testing.T) {
	client, server := pipePair(t)
	got := make(chan string, 1)
	client.HandleNotification("ping", func(_ context.Context, params json.RawMessage) {
		var p struct {
			Msg string `json:"msg"`
		}
		_ = json.Unmarshal(params, &p)
		got <- p.Msg
	})
	server.Start()
	client.Start()

	if err := server.Notify("ping", map[string]string{"msg": "pong"}); err != nil {
		t.Fatalf("notify: %v", err)
	}
	select {
	case m := <-got:
		if m != "pong" {
			t.Fatalf("notification msg = %q, want %q", m, "pong")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for notification")
	}
}

// TestCovRespondResultMarshalError covers respondResult's marshal-error fallback:
// a handler returning a value json.Marshal rejects (a channel) must cause
// respondResult to fall back to respondError, so the caller receives an RPCError
// with CodeInternalError rather than hanging or getting a bad frame.
func TestCovRespondResultMarshalError(t *testing.T) {
	client, server := pipePair(t)
	server.Handle("unmarshalable", func(context.Context, json.RawMessage) (any, error) {
		return make(chan int), nil // json.Marshal cannot encode a channel
	})
	server.Start()
	client.Start()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := client.Call(ctx, "unmarshalable", nil)
	if err == nil {
		t.Fatal("expected an error from unmarshalable result")
	}
	rpcErr, ok := err.(*RPCError)
	if !ok || rpcErr.Code != CodeInternalError {
		t.Fatalf("err = %#v, want RPCError code %d", err, CodeInternalError)
	}
}
