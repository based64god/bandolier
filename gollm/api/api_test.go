package api

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func TestEmbeddingVectorFloatArray(t *testing.T) {
	var v EmbeddingVector
	if err := json.Unmarshal([]byte(`[0.5, -1.25, 3]`), &v); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(v, EmbeddingVector{0.5, -1.25, 3}) {
		t.Errorf("v = %v", v)
	}
}

func TestEmbeddingVectorBase64(t *testing.T) {
	// Pack three float32s little-endian, base64 them — OpenAI's
	// encoding_format:"base64" wire form, which the SDK requests by default.
	floats := []float32{0.5, -1.25, 3}
	buf := make([]byte, len(floats)*4)
	for i, f := range floats {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(f))
	}
	payload, _ := json.Marshal(base64.StdEncoding.EncodeToString(buf))

	var v EmbeddingVector
	if err := json.Unmarshal(payload, &v); err != nil {
		t.Fatalf("base64 embedding must decode: %v", err)
	}
	if !reflect.DeepEqual(v, EmbeddingVector{0.5, -1.25, 3}) {
		t.Errorf("v = %v, want [0.5 -1.25 3]", v)
	}
}

func TestToolChoicePreservesUnknownObjectForm(t *testing.T) {
	// A form gollm doesn't model must round-trip verbatim, not collapse into an
	// empty function choice.
	raw := `{"type":"allowed_tools","mode":"auto","tools":[{"type":"function","function":{"name":"x"}}]}`
	var tc ToolChoice
	if err := json.Unmarshal([]byte(raw), &tc); err != nil {
		t.Fatal(err)
	}
	if tc.Mode != "raw" {
		t.Fatalf("mode = %q, want raw", tc.Mode)
	}
	out, err := json.Marshal(tc)
	if err != nil {
		t.Fatal(err)
	}
	var got, want map[string]any
	_ = json.Unmarshal(out, &got)
	_ = json.Unmarshal([]byte(raw), &want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("round trip = %s", out)
	}
}

func TestToolChoiceFunctionForm(t *testing.T) {
	var tc ToolChoice
	if err := json.Unmarshal([]byte(`{"type":"function","function":{"name":"Bash"}}`), &tc); err != nil {
		t.Fatal(err)
	}
	if tc.Mode != "function" || tc.FunctionName != "Bash" {
		t.Errorf("tc = %+v", tc)
	}
}

func TestChatRequestExtraPreservesRawSchema(t *testing.T) {
	// The Extra merge must not reorder or retype a raw tool schema.
	schema := json.RawMessage(`{"type":"object","properties":{"z":{"type":"integer"},"a":{"type":"string"}},"required":["z","a"]}`)
	req := ChatRequest{
		Model: "gpt-4o",
		Tools: []Tool{{Type: "function", Function: ToolFunction{Name: "f", Parameters: schema}}},
		Extra: map[string]any{"service_tier": "flex"},
	}
	out, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	// The nested schema bytes must appear verbatim (key order preserved).
	if !containsSub(out, string(schema)) {
		t.Errorf("raw schema was reordered/retyped in:\n%s", out)
	}
	// Extra key survives.
	var back map[string]json.RawMessage
	_ = json.Unmarshal(out, &back)
	if string(back["service_tier"]) != `"flex"` {
		t.Errorf("extra service_tier = %s", back["service_tier"])
	}
}

func containsSub(haystack []byte, needle string) bool {
	return len(needle) > 0 && bytesIndex(haystack, needle) >= 0
}

func bytesIndex(h []byte, n string) int {
	nb := []byte(n)
outer:
	for i := 0; i+len(nb) <= len(h); i++ {
		for j := range nb {
			if h[i+j] != nb[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}

func intp(i int) *int { return &i }

func TestAccumulatorIndexlessToolCallsStaySeparate(t *testing.T) {
	// A provider that streams whole tool calls one-per-delta with no index must
	// not have its distinct calls merged into one.
	acc := NewStreamAccumulator()
	acc.Add(&ChatChunk{Choices: []ChunkChoice{{Delta: Delta{ToolCalls: []ToolCall{{
		ID: "call_1", Function: ToolCallFunction{Name: "a", Arguments: `{"x":1}`},
	}}}}}})
	acc.Add(&ChatChunk{Choices: []ChunkChoice{{Delta: Delta{ToolCalls: []ToolCall{{
		ID: "call_2", Function: ToolCallFunction{Name: "b", Arguments: `{"y":2}`},
	}}}}}})
	acc.Add(&ChatChunk{Choices: []ChunkChoice{{FinishReason: "tool_calls"}}})

	resp := acc.Response()
	calls := resp.Choices[0].Message.ToolCalls
	if len(calls) != 2 {
		t.Fatalf("got %d tool calls, want 2: %+v", len(calls), calls)
	}
	if calls[0].Function.Name != "a" || calls[0].Function.Arguments != `{"x":1}` {
		t.Errorf("call 0 = %+v", calls[0])
	}
	if calls[1].Function.Name != "b" || calls[1].Function.Arguments != `{"y":2}` {
		t.Errorf("call 1 = %+v", calls[1])
	}
}

func TestAccumulatorIndexedFragmentsConcatenate(t *testing.T) {
	// Indexed fragments for the same call still concatenate correctly.
	acc := NewStreamAccumulator()
	acc.Add(&ChatChunk{Choices: []ChunkChoice{{Delta: Delta{ToolCalls: []ToolCall{{
		Index: intp(0), ID: "c1", Function: ToolCallFunction{Name: "f"},
	}}}}}})
	acc.Add(&ChatChunk{Choices: []ChunkChoice{{Delta: Delta{ToolCalls: []ToolCall{{
		Index: intp(0), Function: ToolCallFunction{Arguments: `{"a":`},
	}}}}}})
	acc.Add(&ChatChunk{Choices: []ChunkChoice{{Delta: Delta{ToolCalls: []ToolCall{{
		Index: intp(0), Function: ToolCallFunction{Arguments: `1}`},
	}}}}}})

	resp := acc.Response()
	calls := resp.Choices[0].Message.ToolCalls
	if len(calls) != 1 || calls[0].Function.Arguments != `{"a":1}` {
		t.Fatalf("calls = %+v", calls)
	}
}
