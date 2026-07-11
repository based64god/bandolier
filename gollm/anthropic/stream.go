package anthropic

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/based64god/gollm/api"
)

// newID mints an Anthropic-style identifier ("msg_...", "toolu_...").
func newID(prefix string) string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

// ── decoder: Anthropic SSE events → unified chunks ──────────────────────────

// DecodeState folds Messages API stream events into unified ChatChunks (the
// outbound provider direction). One event can produce zero or one chunk.
type DecodeState struct {
	id         string
	model      string
	created    int64
	inputUsage Usage // usage reported at message_start (input side)
	// blockKind and toolIndex track, per Anthropic block index, what kind of
	// block is open and — for tool_use — which OpenAI tool index it maps to.
	blockKind map[int]string
	toolIndex map[int]int
	nextTool  int
}

func NewDecodeState() *DecodeState {
	return &DecodeState{
		blockKind: map[int]string{},
		toolIndex: map[int]int{},
		created:   time.Now().Unix(),
	}
}

// Event folds one decoded stream event; the returned chunk is nil when the
// event carries nothing the unified stream represents (pings, block stops).
// An error event returns a classified *api.Error.
func (d *DecodeState) Event(ev *StreamEvent) (*api.ChatChunk, error) {
	switch ev.Type {
	case "message_start":
		if ev.Message != nil {
			d.id = ev.Message.ID
			d.model = ev.Message.Model
			if ev.Message.Usage != nil {
				d.inputUsage = *ev.Message.Usage
			}
		}
		return d.chunk(api.ChunkChoice{Index: 0, Delta: api.Delta{Role: "assistant"}}, nil), nil

	case "content_block_start":
		if ev.Index == nil || ev.ContentBlock == nil {
			return nil, nil
		}
		d.blockKind[*ev.Index] = ev.ContentBlock.Type
		if ev.ContentBlock.Type == "tool_use" {
			openaiIdx := d.nextTool
			d.nextTool++
			d.toolIndex[*ev.Index] = openaiIdx
			idx := openaiIdx
			return d.chunk(api.ChunkChoice{
				Index: 0,
				Delta: api.Delta{ToolCalls: []api.ToolCall{{
					Index:    &idx,
					ID:       ev.ContentBlock.ID,
					Type:     "function",
					Function: api.ToolCallFunction{Name: ev.ContentBlock.Name},
				}}},
			}, nil), nil
		}
		return nil, nil

	case "content_block_delta":
		if ev.Index == nil || ev.Delta == nil {
			return nil, nil
		}
		switch ev.Delta.Type {
		case "text_delta":
			return d.chunk(api.ChunkChoice{
				Index: 0,
				Delta: api.Delta{Content: ev.Delta.Text},
			}, nil), nil
		case "thinking_delta":
			return d.chunk(api.ChunkChoice{
				Index: 0,
				Delta: api.Delta{ReasoningContent: ev.Delta.Thinking},
			}, nil), nil
		case "signature_delta":
			// The signature must survive translation: Anthropic backends reject
			// multi-turn thinking history whose signatures were stripped.
			return d.chunk(api.ChunkChoice{
				Index: 0,
				Delta: api.Delta{ReasoningSignature: ev.Delta.Signature},
			}, nil), nil
		case "input_json_delta":
			openaiIdx, ok := d.toolIndex[*ev.Index]
			if !ok {
				return nil, nil
			}
			idx := openaiIdx
			return d.chunk(api.ChunkChoice{
				Index: 0,
				Delta: api.Delta{ToolCalls: []api.ToolCall{{
					Index:    &idx,
					Function: api.ToolCallFunction{Arguments: ev.Delta.PartialJSON},
				}}},
			}, nil), nil
		default: // future delta kinds carry nothing unified
			return nil, nil
		}

	case "message_delta":
		var usage *api.Usage
		if ev.Usage != nil {
			total := d.inputUsage
			total.OutputTokens = ev.Usage.OutputTokens
			if ev.Usage.InputTokens > 0 {
				total.InputTokens = ev.Usage.InputTokens
			}
			if ev.Usage.CacheReadInputTokens > 0 {
				total.CacheReadInputTokens = ev.Usage.CacheReadInputTokens
			}
			if ev.Usage.CacheCreationInputTokens > 0 {
				total.CacheCreationInputTokens = ev.Usage.CacheCreationInputTokens
			}
			usage = UsageToUnified(&total)
		}
		finish := ""
		if ev.Delta != nil {
			finish = StopReasonToFinish(ev.Delta.StopReason)
		}
		return d.chunk(api.ChunkChoice{Index: 0, FinishReason: finish}, usage), nil

	case "error":
		msg := "stream error"
		code := ""
		if ev.Error != nil {
			msg = ev.Error.Message
			code = ev.Error.Type
		}
		return nil, &api.Error{
			Type:       streamErrorType(code),
			StatusCode: 500,
			Code:       code,
			Message:    msg,
			Provider:   "anthropic",
			Model:      d.model,
		}

	// ping, content_block_stop, message_stop carry nothing unified; the
	// transport layer ends the stream on message_stop.
	default:
		return nil, nil
	}
}

func streamErrorType(code string) api.ErrorType {
	switch code {
	case "overloaded_error":
		return api.ErrUnavailable
	case "rate_limit_error":
		return api.ErrRateLimit
	case "authentication_error":
		return api.ErrAuthentication
	case "invalid_request_error":
		return api.ErrBadRequest
	default:
		return api.ErrInternalServer
	}
}

func (d *DecodeState) chunk(choice api.ChunkChoice, usage *api.Usage) *api.ChatChunk {
	return &api.ChatChunk{
		ID:      d.id,
		Object:  "chat.completion.chunk",
		Created: d.created,
		Model:   d.model,
		Choices: []api.ChunkChoice{choice},
		Usage:   usage,
	}
}

// ── encoder: unified chunks → Anthropic SSE events ──────────────────────────

// Event is one outbound SSE event: the event name and its JSON payload.
type Event struct {
	Name string
	Data []byte
}

func newEvent(name string, payload any) Event {
	data, _ := json.Marshal(payload)
	return Event{Name: name, Data: data}
}

// EncodeState converts a unified chunk stream into the Messages API event
// sequence (the inbound proxy direction — this is what an Anthropic-format
// client such as Claude Code receives). It maintains the content-block state
// machine: blocks open and close as the unified stream interleaves text,
// reasoning, and tool-call deltas, and indices/ids are synthesized where the
// backend didn't provide Anthropic-shaped ones.
type EncodeState struct {
	// Model is the model name to report in message_start. Set it to the model
	// the client asked for (its alias), not the backend model, so clients that
	// validate the echo aren't surprised.
	model string
	msgID string

	started    bool
	nextIndex  int    // next Anthropic content-block index
	openKind   string // "" | "text" | "thinking" | "tool_use"
	openIndex  int    // Anthropic index of the open block
	openToolID string

	// toolBlocks maps OpenAI tool index → Anthropic block index, for
	// argument fragments that arrive after the block opened.
	toolBlocks map[int]int
	lastTool   int // OpenAI index of the most recently opened tool block
	nextSynth  int // next synthetic OpenAI index for index-less fragments

	// toolNameMap restores original tool names (sanitized → original) that
	// RequestToUnifiedWithTools rewrote to satisfy OpenAI's name constraints.
	toolNameMap map[string]string

	finish string
	usage  *api.Usage
}

// NewEncodeState builds an encoder that reports the given model name.
func NewEncodeState(model string) *EncodeState {
	return &EncodeState{
		model:      model,
		msgID:      newID("msg"),
		toolBlocks: map[int]int{},
		lastTool:   -1,
	}
}

// NewEncodeStateWithNames additionally restores original tool names in
// tool_use blocks through the sanitized→original map produced by
// RequestToUnifiedWithTools.
func NewEncodeStateWithNames(model string, names map[string]string) *EncodeState {
	e := NewEncodeState(model)
	e.toolNameMap = names
	return e
}

// Chunk folds one unified chunk and returns the SSE events it produces.
func (e *EncodeState) Chunk(chunk *api.ChatChunk) []Event {
	var events []Event
	if !e.started {
		e.started = true
		events = append(events, newEvent("message_start", map[string]any{
			"type": "message_start",
			"message": MessagesResponse{
				ID:      e.msgID,
				Type:    "message",
				Role:    "assistant",
				Model:   e.model,
				Content: []ContentBlock{},
				Usage:   &Usage{InputTokens: 0, OutputTokens: 0},
			},
		}))
	}
	if chunk == nil {
		return events
	}
	if chunk.Usage != nil {
		e.usage = chunk.Usage
	}

	for _, choice := range chunk.Choices {
		if choice.Index != 0 {
			continue // the Messages API has no multi-choice representation
		}
		d := choice.Delta

		if d.ReasoningContent != "" {
			events = append(events, e.ensureBlock("thinking", nil)...)
			events = append(events, newEvent("content_block_delta", map[string]any{
				"type":  "content_block_delta",
				"index": e.openIndex,
				"delta": EventDelta{Type: "thinking_delta", Thinking: d.ReasoningContent},
			}))
		}

		if d.ReasoningSignature != "" {
			// The signature closes out a thinking block; without it Anthropic
			// clients can't replay the block in multi-turn history.
			events = append(events, e.ensureBlock("thinking", nil)...)
			events = append(events, newEvent("content_block_delta", map[string]any{
				"type":  "content_block_delta",
				"index": e.openIndex,
				"delta": EventDelta{Type: "signature_delta", Signature: d.ReasoningSignature},
			}))
		}

		if d.Content != "" {
			events = append(events, e.ensureBlock("text", nil)...)
			events = append(events, newEvent("content_block_delta", map[string]any{
				"type":  "content_block_delta",
				"index": e.openIndex,
				"delta": EventDelta{Type: "text_delta", Text: d.Content},
			}))
		}

		for i, tc := range d.ToolCalls {
			events = append(events, e.toolDelta(i, tc)...)
		}

		if choice.FinishReason != "" {
			e.finish = choice.FinishReason
		}
	}
	return events
}

// toolDelta handles one streamed tool-call fragment: opening a tool_use block
// when the fragment starts a new call, then streaming its argument bytes.
func (e *EncodeState) toolDelta(pos int, tc api.ToolCall) []Event {
	// OpenAI correlates fragments by index. When absent, a fragment carrying
	// a fresh id or name starts a NEW call (mirrors the api accumulator —
	// position can't correlate across chunks, so keying on it would merge
	// distinct whole-call deltas); a fragment with neither continues the call
	// most recently opened.
	var openaiIdx int
	switch {
	case tc.Index != nil:
		openaiIdx = *tc.Index
	case tc.ID != "" || tc.Function.Name != "":
		for {
			if _, used := e.toolBlocks[e.nextSynth]; !used {
				break
			}
			e.nextSynth++
		}
		openaiIdx = e.nextSynth
		e.nextSynth++
	case e.lastTool >= 0:
		openaiIdx = e.lastTool
	default:
		openaiIdx = pos
	}

	var events []Event
	blockIdx, known := e.toolBlocks[openaiIdx]
	if !known {
		// New tool call: open its block (closing whatever else was open).
		id := tc.ID
		if id == "" {
			id = newID("toolu")
		}
		events = append(events, e.closeOpen()...)
		blockIdx = e.nextIndex
		e.nextIndex++
		e.toolBlocks[openaiIdx] = blockIdx
		e.lastTool = openaiIdx
		e.openKind = "tool_use"
		e.openIndex = blockIdx
		e.openToolID = id
		name := tc.Function.Name
		if orig, ok := e.toolNameMap[name]; ok {
			name = orig
		}
		events = append(events, newEvent("content_block_start", map[string]any{
			"type":  "content_block_start",
			"index": blockIdx,
			"content_block": ContentBlock{
				Type:  "tool_use",
				ID:    id,
				Name:  name,
				Input: json.RawMessage("{}"),
			},
		}))
	} else if e.openKind != "tool_use" || e.openIndex != blockIdx {
		// Fragments for an earlier tool while another block is open: the
		// Messages API allows deltas only for the open block, so reopening is
		// not representable. In practice OpenAI streams tool calls strictly
		// sequentially; guard by treating it as the open block if any.
		if e.openKind != "tool_use" {
			return events
		}
		blockIdx = e.openIndex
	}

	if tc.Function.Arguments != "" {
		events = append(events, newEvent("content_block_delta", map[string]any{
			"type":  "content_block_delta",
			"index": blockIdx,
			"delta": EventDelta{Type: "input_json_delta", PartialJSON: tc.Function.Arguments},
		}))
	}
	return events
}

// ensureBlock guarantees a block of the wanted kind is open, closing and
// opening blocks as needed.
func (e *EncodeState) ensureBlock(kind string, _ *api.ToolCall) []Event {
	if e.openKind == kind {
		return nil
	}
	events := e.closeOpen()
	idx := e.nextIndex
	e.nextIndex++
	e.openKind = kind
	e.openIndex = idx

	// The official SDK streaming helpers require the start payload to carry
	// the block's empty content fields; ContentBlock's omitempty tags (needed
	// for request parsing) would drop them, so the payload is built explicitly.
	var block map[string]any
	switch kind {
	case "text":
		block = map[string]any{"type": "text", "text": ""}
	case "thinking":
		block = map[string]any{"type": "thinking", "thinking": "", "signature": ""}
	default:
		block = map[string]any{"type": kind}
	}
	events = append(events, newEvent("content_block_start", map[string]any{
		"type":          "content_block_start",
		"index":         idx,
		"content_block": block,
	}))
	return events
}

func (e *EncodeState) closeOpen() []Event {
	if e.openKind == "" {
		return nil
	}
	ev := newEvent("content_block_stop", map[string]any{
		"type":  "content_block_stop",
		"index": e.openIndex,
	})
	e.openKind = ""
	e.openToolID = ""
	return []Event{ev}
}

// Finish emits the closing event sequence (block stop, message_delta with
// stop_reason and usage, message_stop). Call after the unified stream ends.
func (e *EncodeState) Finish() []Event {
	var events []Event
	if !e.started {
		// Empty upstream stream: still emit a valid, empty message.
		events = append(events, e.Chunk(nil)...)
	}
	events = append(events, e.closeOpen()...)

	stop := FinishToStopReason(e.finish)
	if stop == "" {
		stop = "end_turn"
	}
	usage := UsageFromUnified(e.usage)
	if usage == nil {
		usage = &Usage{}
	}
	events = append(events,
		newEvent("message_delta", map[string]any{
			"type":  "message_delta",
			"delta": EventDelta{Type: "", StopReason: stop},
			"usage": usage,
		}),
		newEvent("message_stop", map[string]any{"type": "message_stop"}),
	)
	return events
}

// FinishError emits a mid-stream error event in Anthropic's format.
func (e *EncodeState) FinishError(err error) []Event {
	detail := ErrorDetail{Type: "api_error", Message: err.Error()}
	if apiErr, ok := api.AsError(err); ok {
		detail.Type = anthropicErrorType(apiErr.Type)
		detail.Message = apiErr.Message
	}
	return []Event{newEvent("error", map[string]any{
		"type":  "error",
		"error": detail,
	})}
}

// anthropicErrorType maps unified error types onto Anthropic's error type
// strings (used both for stream error events and error response bodies).
func anthropicErrorType(t api.ErrorType) string {
	switch t {
	case api.ErrAuthentication:
		return "authentication_error"
	case api.ErrPermission:
		return "permission_error"
	case api.ErrNotFound:
		return "not_found_error"
	case api.ErrRateLimit:
		return "rate_limit_error"
	case api.ErrBadRequest, api.ErrContextWindow, api.ErrContentPolicy,
		api.ErrUnprocessable, api.ErrNotSupported:
		return "invalid_request_error"
	case api.ErrUnavailable:
		return "overloaded_error"
	case api.ErrTimeout:
		return "timeout_error"
	default:
		return "api_error"
	}
}

// ErrorBody renders a unified error as an Anthropic error envelope with the
// HTTP status to serve it under.
func ErrorBody(err error) (status int, body ErrorResponse) {
	detail := ErrorDetail{Type: "api_error", Message: err.Error()}
	status = 500
	if apiErr, ok := api.AsError(err); ok {
		detail.Type = anthropicErrorType(apiErr.Type)
		detail.Message = apiErr.Message
		if apiErr.StatusCode != 0 {
			status = apiErr.StatusCode
		}
	}
	return status, ErrorResponse{Type: "error", Error: detail}
}

// FormatSSE renders an event in SSE wire form.
func (ev Event) FormatSSE() []byte {
	return fmt.Appendf(nil, "event: %s\ndata: %s\n\n", ev.Name, ev.Data)
}
