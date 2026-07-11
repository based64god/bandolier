package anthropic

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

func intp(i int) *int { return &i }

// collectNames flattens the event names of a sequence for order assertions.
func collectNames(events []Event) string {
	names := make([]string, len(events))
	for i, e := range events {
		names[i] = e.Name
	}
	return strings.Join(names, " ")
}

func decodeEvent(t *testing.T, e Event) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(e.Data, &m); err != nil {
		t.Fatalf("event %s: bad JSON %s: %v", e.Name, e.Data, err)
	}
	return m
}

// TestEncodeTextThenToolCalls drives the encoder with the chunk sequence an
// OpenAI backend produces for "text, then two tool calls" and asserts the
// exact Anthropic event structure Claude Code expects.
func TestEncodeTextThenToolCalls(t *testing.T) {
	enc := NewEncodeState("claude-sonnet-4-5")

	var events []Event
	push := func(chunks ...*api.ChatChunk) {
		for _, c := range chunks {
			events = append(events, enc.Chunk(c)...)
		}
	}

	push(
		&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{Role: "assistant"}}}},
		&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{Content: "I'll run "}}}},
		&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{Content: "both."}}}},
		// Tool 0 opens: id+name first, then argument fragments.
		&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{ToolCalls: []api.ToolCall{{
			Index: intp(0), ID: "call_a", Type: "function",
			Function: api.ToolCallFunction{Name: "Bash"},
		}}}}}},
		&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{ToolCalls: []api.ToolCall{{
			Index: intp(0), Function: api.ToolCallFunction{Arguments: `{"comm`},
		}}}}}},
		&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{ToolCalls: []api.ToolCall{{
			Index: intp(0), Function: api.ToolCallFunction{Arguments: `and":"ls"}`},
		}}}}}},
		// Tool 1.
		&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{ToolCalls: []api.ToolCall{{
			Index: intp(1), ID: "call_b", Type: "function",
			Function: api.ToolCallFunction{Name: "Read", Arguments: `{"path":"a.txt"}`},
		}}}}}},
		&api.ChatChunk{
			Choices: []api.ChunkChoice{{FinishReason: "tool_calls"}},
			Usage:   &api.Usage{PromptTokens: 20, CompletionTokens: 30, TotalTokens: 50},
		},
	)
	events = append(events, enc.Finish()...)

	want := strings.Join([]string{
		"message_start",
		"content_block_start", // text
		"content_block_delta",
		"content_block_delta",
		"content_block_stop",
		"content_block_start", // tool 0
		"content_block_delta",
		"content_block_delta",
		"content_block_stop",
		"content_block_start", // tool 1
		"content_block_delta",
		"content_block_stop",
		"message_delta",
		"message_stop",
	}, " ")
	if got := collectNames(events); got != want {
		t.Fatalf("event order:\n got %s\nwant %s", got, want)
	}

	// Indices must be sequential per block: text=0, tool0=1, tool1=2.
	toolStart := decodeEvent(t, events[5])
	if toolStart["index"].(float64) != 1 {
		t.Errorf("first tool block index = %v, want 1", toolStart["index"])
	}
	cb := toolStart["content_block"].(map[string]any)
	if cb["type"] != "tool_use" || cb["name"] != "Bash" || cb["id"] != "call_a" {
		t.Errorf("tool block = %v", cb)
	}

	// Argument fragments must concatenate to the full JSON.
	frag1 := decodeEvent(t, events[6])["delta"].(map[string]any)["partial_json"].(string)
	frag2 := decodeEvent(t, events[7])["delta"].(map[string]any)["partial_json"].(string)
	if frag1+frag2 != `{"command":"ls"}` {
		t.Errorf("joined fragments = %q", frag1+frag2)
	}

	// message_delta carries stop_reason tool_use and output token usage.
	md := decodeEvent(t, events[len(events)-2])
	if md["delta"].(map[string]any)["stop_reason"] != "tool_use" {
		t.Errorf("stop_reason = %v", md["delta"])
	}
	if md["usage"].(map[string]any)["output_tokens"].(float64) != 30 {
		t.Errorf("usage = %v", md["usage"])
	}
}

func TestEncodeEmptyStreamStillWellFormed(t *testing.T) {
	enc := NewEncodeState("claude-3-5-haiku")
	events := enc.Finish()
	got := collectNames(events)
	want := "message_start message_delta message_stop"
	if got != want {
		t.Fatalf("events = %s, want %s", got, want)
	}
	md := decodeEvent(t, events[1])
	if md["delta"].(map[string]any)["stop_reason"] != "end_turn" {
		t.Errorf("stop_reason = %v", md["delta"])
	}
}

func TestEncodeReasoningBecomesThinkingBlock(t *testing.T) {
	enc := NewEncodeState("claude-sonnet-4-5")
	var events []Event
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ReasoningContent: "hmm, "},
	}}})...)
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{Content: "answer"},
	}}})...)
	events = append(events, enc.Finish()...)

	want := strings.Join([]string{
		"message_start",
		"content_block_start", // thinking
		"content_block_delta",
		"content_block_stop",
		"content_block_start", // text
		"content_block_delta",
		"content_block_stop",
		"message_delta",
		"message_stop",
	}, " ")
	if got := collectNames(events); got != want {
		t.Fatalf("event order:\n got %s\nwant %s", got, want)
	}
	start := decodeEvent(t, events[1])
	if start["content_block"].(map[string]any)["type"] != "thinking" {
		t.Errorf("first block = %v", start["content_block"])
	}
	delta := decodeEvent(t, events[2])["delta"].(map[string]any)
	if delta["type"] != "thinking_delta" || delta["thinking"] != "hmm, " {
		t.Errorf("thinking delta = %v", delta)
	}
}

// TestEncodeBlockStartCarriesEmptyContentFields: the official SDK streaming
// helpers accumulate onto the start payload's content fields, so text blocks
// must open with "text":"" and thinking blocks with "thinking":"" and
// "signature":"" — omitting them crashes the Python SDK (NoneType += str).
func TestEncodeBlockStartCarriesEmptyContentFields(t *testing.T) {
	enc := NewEncodeState("m")
	var textStart Event
	for _, e := range enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{Content: "hi"},
	}}}) {
		if e.Name == "content_block_start" {
			textStart = e
		}
	}
	if !strings.Contains(string(textStart.Data), `"text":""`) {
		t.Errorf("text content_block_start = %s, want it to contain %q", textStart.Data, `"text":""`)
	}

	enc = NewEncodeState("m")
	var thinkStart Event
	for _, e := range enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ReasoningContent: "hm"},
	}}}) {
		if e.Name == "content_block_start" {
			thinkStart = e
		}
	}
	for _, want := range []string{`"thinking":""`, `"signature":""`} {
		if !strings.Contains(string(thinkStart.Data), want) {
			t.Errorf("thinking content_block_start = %s, want it to contain %q", thinkStart.Data, want)
		}
	}
}

// TestDecodeSignatureDelta: the thinking-block signature must survive into the
// unified stream or Anthropic backends reject replayed multi-turn thinking.
func TestDecodeSignatureDelta(t *testing.T) {
	dec := NewDecodeState()
	var ev StreamEvent
	if err := json.Unmarshal([]byte(`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc"}}`), &ev); err != nil {
		t.Fatal(err)
	}
	chunk, err := dec.Event(&ev)
	if err != nil {
		t.Fatal(err)
	}
	if chunk == nil || len(chunk.Choices) != 1 {
		t.Fatalf("chunk = %+v", chunk)
	}
	if got := chunk.Choices[0].Delta.ReasoningSignature; got != "sig_abc" {
		t.Errorf("ReasoningSignature = %q, want sig_abc", got)
	}
}

// TestEncodeSignatureDelta: a unified signature fragment becomes a
// signature_delta on the open thinking block, not a new block.
func TestEncodeSignatureDelta(t *testing.T) {
	enc := NewEncodeState("m")
	var events []Event
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ReasoningContent: "hm"},
	}}})...)
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ReasoningSignature: "sig_abc"},
	}}})...)

	starts := 0
	var sig map[string]any
	for _, e := range events {
		if e.Name == "content_block_start" {
			starts++
		}
		if e.Name == "content_block_delta" {
			m := decodeEvent(t, e)
			if m["delta"].(map[string]any)["type"] == "signature_delta" {
				sig = m
			}
		}
	}
	if starts != 1 {
		t.Errorf("content_block_start count = %d, want 1 (signature must not open a new block)", starts)
	}
	if sig == nil {
		t.Fatal("no signature_delta emitted")
	}
	if got := sig["delta"].(map[string]any)["signature"]; got != "sig_abc" {
		t.Errorf("signature = %v, want sig_abc", got)
	}
	if got := sig["index"].(float64); got != 0 {
		t.Errorf("signature index = %v, want the thinking block's 0", got)
	}
}

// TestEncodeIndexlessWholeToolCallsSeparateBlocks: providers that stream one
// whole call per delta without indices must yield one tool_use block per call
// — correlating by chunk position would merge them.
func TestEncodeIndexlessWholeToolCallsSeparateBlocks(t *testing.T) {
	enc := NewEncodeState("m")
	var events []Event
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ToolCalls: []api.ToolCall{{
			ID: "call_1", Type: "function",
			Function: api.ToolCallFunction{Name: "f1", Arguments: `{"a":1}`},
		}}},
	}}})...)
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ToolCalls: []api.ToolCall{{
			ID: "call_2", Type: "function",
			Function: api.ToolCallFunction{Name: "f2", Arguments: `{"b":2}`},
		}}},
	}}})...)
	events = append(events, enc.Finish()...)

	var starts []map[string]any
	for _, e := range events {
		if e.Name == "content_block_start" {
			starts = append(starts, decodeEvent(t, e))
		}
	}
	if len(starts) != 2 {
		t.Fatalf("content_block_start count = %d, want 2 distinct tool_use blocks", len(starts))
	}
	for i, want := range []struct{ id, name string }{{"call_1", "f1"}, {"call_2", "f2"}} {
		cb := starts[i]["content_block"].(map[string]any)
		if cb["id"] != want.id || cb["name"] != want.name {
			t.Errorf("block %d = %v, want id=%s name=%s", i, cb, want.id, want.name)
		}
	}
	if starts[0]["index"].(float64) == starts[1]["index"].(float64) {
		t.Errorf("both blocks share index %v", starts[0]["index"])
	}
}

// TestEncodeStreamRestoresSanitizedToolName: the backend emits the sanitized
// name; the client must see the original (Claude Code matches tools by name).
func TestEncodeStreamRestoresSanitizedToolName(t *testing.T) {
	long := "mcp__myserver__" + strings.Repeat("a", 55) // 70 chars
	sanitized := sanitizeToolName(long)
	enc := NewEncodeStateWithNames("m", map[string]string{sanitized: long})
	events := enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ToolCalls: []api.ToolCall{{
			Index: intp(0), ID: "call_1", Type: "function",
			Function: api.ToolCallFunction{Name: sanitized, Arguments: "{}"},
		}}},
	}}})
	var start map[string]any
	for _, e := range events {
		if e.Name == "content_block_start" {
			start = decodeEvent(t, e)
		}
	}
	if got := start["content_block"].(map[string]any)["name"]; got != long {
		t.Errorf("streamed tool name = %q, want original %q", got, long)
	}
}

func TestEncodeSynthesizesToolIDs(t *testing.T) {
	enc := NewEncodeState("m")
	events := enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{
		Delta: api.Delta{ToolCalls: []api.ToolCall{{
			Index:    intp(0),
			Function: api.ToolCallFunction{Name: "f", Arguments: "{}"},
		}}},
	}}})
	var start map[string]any
	for _, e := range events {
		if e.Name == "content_block_start" {
			start = decodeEvent(t, e)
		}
	}
	id := start["content_block"].(map[string]any)["id"].(string)
	if !strings.HasPrefix(id, "toolu_") {
		t.Errorf("synthesized id = %q, want toolu_ prefix", id)
	}
}

// TestDecodeAnthropicStream drives the decoder with a realistic Messages API
// event sequence and verifies the accumulated unified response.
func TestDecodeAnthropicStream(t *testing.T) {
	raw := []string{
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":25,"cache_read_input_tokens":100,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"Bash","input":{}}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"pwd\"}"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"ping"}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":40}}`,
		`{"type":"message_stop"}`,
	}

	dec := NewDecodeState()
	acc := api.NewStreamAccumulator()
	for _, line := range raw {
		var ev StreamEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("event decode: %v", err)
		}
		chunk, err := dec.Event(&ev)
		if err != nil {
			t.Fatalf("Event: %v", err)
		}
		acc.Add(chunk)
	}

	resp := acc.Response()
	if resp.ID != "msg_1" || resp.Model != "claude-sonnet-4-5" {
		t.Errorf("id/model = %q/%q", resp.ID, resp.Model)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("choices = %+v", resp.Choices)
	}
	choice := resp.Choices[0]
	if choice.FinishReason != "tool_calls" {
		t.Errorf("finish = %q", choice.FinishReason)
	}
	if got := choice.Message.Content.AsText(); got != "Let me check." {
		t.Errorf("content = %q", got)
	}
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %+v", choice.Message.ToolCalls)
	}
	tc := choice.Message.ToolCalls[0]
	if tc.ID != "toolu_9" || tc.Function.Name != "Bash" || tc.Function.Arguments != `{"command":"pwd"}` {
		t.Errorf("tool call = %+v", tc)
	}
	// Usage: input 25 + cache read 100 = 125 prompt; output 40 from message_delta.
	if resp.Usage == nil || resp.Usage.PromptTokens != 125 || resp.Usage.CompletionTokens != 40 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestDecodeErrorEvent(t *testing.T) {
	dec := NewDecodeState()
	var ev StreamEvent
	if err := json.Unmarshal([]byte(`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`), &ev); err != nil {
		t.Fatal(err)
	}
	_, err := dec.Event(&ev)
	apiErr, ok := api.AsError(err)
	if !ok {
		t.Fatalf("err = %v, want *api.Error", err)
	}
	if apiErr.Type != api.ErrUnavailable {
		t.Errorf("type = %s", apiErr.Type)
	}
	if !apiErr.Retryable() {
		t.Error("overloaded must be retryable")
	}
}

// Encoder → decoder round trip: what the proxy emits must be consumable by
// our own Anthropic stream decoder and reproduce the unified content.
func TestEncodeDecodeRoundTrip(t *testing.T) {
	enc := NewEncodeState("claude-sonnet-4-5")
	var events []Event
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{Content: "hello "}}}})...)
	events = append(events, enc.Chunk(&api.ChatChunk{Choices: []api.ChunkChoice{{Delta: api.Delta{Content: "world"}}}})...)
	events = append(events, enc.Chunk(&api.ChatChunk{
		Choices: []api.ChunkChoice{{FinishReason: "stop"}},
		Usage:   &api.Usage{PromptTokens: 5, CompletionTokens: 2, TotalTokens: 7},
	})...)
	events = append(events, enc.Finish()...)

	dec := NewDecodeState()
	acc := api.NewStreamAccumulator()
	for _, e := range events {
		var ev StreamEvent
		if err := json.Unmarshal(e.Data, &ev); err != nil {
			t.Fatalf("round-trip decode %s: %v", e.Name, err)
		}
		chunk, err := dec.Event(&ev)
		if err != nil {
			t.Fatal(err)
		}
		acc.Add(chunk)
	}
	resp := acc.Response()
	if got := resp.Choices[0].Message.Content.AsText(); got != "hello world" {
		t.Errorf("content = %q", got)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Errorf("finish = %q", resp.Choices[0].FinishReason)
	}
	if resp.Usage == nil || resp.Usage.CompletionTokens != 2 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestFormatSSE(t *testing.T) {
	ev := Event{Name: "message_stop", Data: []byte(`{"type":"message_stop"}`)}
	got := string(ev.FormatSSE())
	want := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	if got != want {
		t.Errorf("sse = %q", got)
	}
}
