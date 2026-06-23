// Package acp implements the subset of the Agent Client Protocol
// (https://agentclientprotocol.com) that Bandolier needs to drive interactive
// agent sessions: a newline-delimited JSON-RPC 2.0 transport plus the ACP method
// and notification types. It is std-lib only and usable from either side of the
// connection (the agent server, the proxy, or a test client).
package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// ProtocolVersion is the ACP protocol version this implementation speaks.
const ProtocolVersion = 1

// JSON-RPC 2.0 error codes.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

// RPCError is a JSON-RPC 2.0 error object. It doubles as a Go error so handlers
// can return a precise code by returning an *RPCError.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message) }

// wireMessage is the on-the-wire JSON-RPC 2.0 envelope. One struct covers
// requests, responses, and notifications; absent fields are omitted. ID is a raw
// message so it round-trips numbers or strings verbatim, and a nil ID marks a
// notification.
type wireMessage struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *RPCError        `json:"error,omitempty"`
}

// MethodHandler handles an inbound request and returns a result to marshal, or
// an error (return an *RPCError to control the JSON-RPC error code).
type MethodHandler func(ctx context.Context, params json.RawMessage) (any, error)

// NotificationHandler handles an inbound notification. Handlers run on a single
// worker goroutine, so notifications are delivered in order; they must not block
// indefinitely (in particular they must not make a blocking Call on the same
// connection).
type NotificationHandler func(ctx context.Context, params json.RawMessage)

// Conn is a bidirectional JSON-RPC 2.0 connection over a newline-delimited
// stream. It is safe for concurrent use.
type Conn struct {
	w   io.Writer
	r   *bufio.Reader
	wmu sync.Mutex

	methods map[string]MethodHandler
	notifs  map[string]NotificationHandler

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan wireMessage

	notifQ   chan wireMessage
	done     chan struct{}
	closeErr error
	onError  func(error)
}

// NewConn creates a connection over r/w. It does not read or write until Start
// is called, so handlers can be registered first without racing the read loop.
func NewConn(r io.Reader, w io.Writer) *Conn {
	return &Conn{
		w:       w,
		r:       bufio.NewReaderSize(r, 1<<20),
		methods: map[string]MethodHandler{},
		notifs:  map[string]NotificationHandler{},
		pending: map[int64]chan wireMessage{},
		notifQ:  make(chan wireMessage, 256),
		done:    make(chan struct{}),
	}
}

// Start begins the reader and notification loops. Register all handlers (Handle,
// HandleNotification, OnError) before calling it: launching the goroutines here
// establishes a happens-before from registration to dispatch, so the handler
// maps need no further synchronization and are read-only thereafter. Call once.
func (c *Conn) Start() {
	go c.notifyLoop()
	go c.readLoop()
}

// Handle registers a handler for an inbound request method. Call before Start;
// the handler maps are read-only once the loops are running.
func (c *Conn) Handle(method string, h MethodHandler) { c.methods[method] = h }

// HandleNotification registers a handler for an inbound notification method.
func (c *Conn) HandleNotification(method string, h NotificationHandler) { c.notifs[method] = h }

// OnError sets a callback for transport-level decode errors (malformed frames).
func (c *Conn) OnError(f func(error)) { c.onError = f }

// Wait blocks until the connection's reader stops (peer closed or errored) and
// returns the terminating error, if any (nil on a clean EOF).
func (c *Conn) Wait() error {
	<-c.done
	return c.closeErr
}

// Call sends a request and blocks for the matching response. params may be nil,
// a json.RawMessage, or any value to marshal.
func (c *Conn) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := marshalParams(params)
	if err != nil {
		return nil, err
	}
	id := atomic.AddInt64(&c.nextID, 1)
	ch := make(chan wireMessage, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	idRaw := json.RawMessage(strconv.FormatInt(id, 10))
	if err := c.send(wireMessage{ID: &idRaw, Method: method, Params: raw}); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, errors.New("acp: connection closed")
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	}
}

// CallResult is Call plus unmarshaling the response into out (skipped if nil).
func (c *Conn) CallResult(ctx context.Context, method string, params, out any) error {
	raw, err := c.Call(ctx, method, params)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// Notify sends a one-way notification (no response expected).
func (c *Conn) Notify(method string, params any) error {
	raw, err := marshalParams(params)
	if err != nil {
		return err
	}
	return c.send(wireMessage{Method: method, Params: raw})
}

func (c *Conn) readLoop() {
	defer close(c.done)
	defer close(c.notifQ)
	for {
		line, err := c.r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			c.dispatch(line)
		}
		if err != nil {
			if err != io.EOF {
				c.closeErr = err
			}
			return
		}
	}
}

func (c *Conn) notifyLoop() {
	for m := range c.notifQ {
		if h := c.notifs[m.Method]; h != nil {
			h(context.Background(), m.Params)
		}
	}
}

func (c *Conn) dispatch(line []byte) {
	var m wireMessage
	if err := json.Unmarshal(line, &m); err != nil {
		c.reportErr(fmt.Errorf("acp: decode message: %w", err))
		return
	}
	switch {
	case m.Method != "" && m.ID != nil:
		// Inbound request — handle off the read loop so a long-running handler
		// (e.g. session/prompt) doesn't stall reads of cancels or responses.
		go c.handleRequest(m)
	case m.Method != "":
		// Inbound notification — queued so ordering is preserved without blocking
		// the read loop.
		select {
		case c.notifQ <- m:
		case <-c.done:
		}
	default:
		c.deliver(m)
	}
}

func (c *Conn) handleRequest(m wireMessage) {
	h := c.methods[m.Method]
	if h == nil {
		c.respondError(m.ID, &RPCError{Code: CodeMethodNotFound, Message: "method not found: " + m.Method})
		return
	}
	result, err := h(context.Background(), m.Params)
	if err != nil {
		var rpcErr *RPCError
		if errors.As(err, &rpcErr) {
			c.respondError(m.ID, rpcErr)
		} else {
			c.respondError(m.ID, &RPCError{Code: CodeInternalError, Message: err.Error()})
		}
		return
	}
	c.respondResult(m.ID, result)
}

func (c *Conn) deliver(m wireMessage) {
	if m.ID == nil {
		return
	}
	id, err := strconv.ParseInt(strings.TrimSpace(string(*m.ID)), 10, 64)
	if err != nil {
		return
	}
	c.mu.Lock()
	ch := c.pending[id]
	c.mu.Unlock()
	if ch != nil {
		ch <- m
	}
}

func (c *Conn) respondResult(id *json.RawMessage, result any) {
	raw, err := json.Marshal(result)
	if err != nil {
		c.respondError(id, &RPCError{Code: CodeInternalError, Message: err.Error()})
		return
	}
	_ = c.send(wireMessage{ID: id, Result: raw})
}

func (c *Conn) respondError(id *json.RawMessage, e *RPCError) {
	_ = c.send(wireMessage{ID: id, Error: e})
}

func (c *Conn) send(m wireMessage) error {
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(b)
	return err
}

func (c *Conn) reportErr(err error) {
	if c.onError != nil {
		c.onError(err)
	}
}

func marshalParams(params any) (json.RawMessage, error) {
	if params == nil {
		return nil, nil
	}
	if raw, ok := params.(json.RawMessage); ok {
		return raw, nil
	}
	return json.Marshal(params)
}
