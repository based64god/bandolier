package tokens

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/based64god/gollm/anthropic"
	"github.com/based64god/gollm/api"
)

func TestEstimateText(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"a", 1}, // non-empty floors at 1
		{"abcd", 1},
		{"abcde", 2}, // ceil(5/4)
		{"12345678", 2},
		{strings.Repeat("x", 100), 25},
	}
	for _, c := range cases {
		if got := EstimateText(c.in); got != c.want {
			t.Errorf("EstimateText(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestEstimateTextMonotonic(t *testing.T) {
	prev := 0
	for i := 1; i <= 64; i++ {
		got := EstimateText(strings.Repeat("a", i))
		if got < prev {
			t.Fatalf("EstimateText not monotonic at len %d: %d < %d", i, got, prev)
		}
		prev = got
	}
}

func TestEstimateMessagesOverhead(t *testing.T) {
	if got := EstimateMessages(nil); got != basePriming {
		t.Fatalf("EstimateMessages(nil) = %d, want %d", got, basePriming)
	}

	// "user" (4 bytes → 1) + "abcd" (4 bytes → 1) + 4 overhead + 3 base.
	one := []api.Message{{Role: "user", Content: api.TextContent("abcd")}}
	if got, want := EstimateMessages(one), basePriming+perMessageOverhead+1+1; got != want {
		t.Fatalf("EstimateMessages(one) = %d, want %d", got, want)
	}

	// Each additional identical message adds exactly overhead+role+content.
	two := append(one, one[0])
	if got, want := EstimateMessages(two), EstimateMessages(one)+perMessageOverhead+1+1; got != want {
		t.Fatalf("EstimateMessages(two) = %d, want %d", got, want)
	}
}

func TestEstimateMessagesToolCalls(t *testing.T) {
	base := []api.Message{{Role: "assistant"}}
	withCall := []api.Message{{
		Role: "assistant",
		ToolCalls: []api.ToolCall{{
			Function: api.ToolCallFunction{Name: "get_weather", Arguments: `{"city":"Paris"}`},
		}},
	}}
	want := EstimateMessages(base) + EstimateText("get_weather") + EstimateText(`{"city":"Paris"}`)
	if got := EstimateMessages(withCall); got != want {
		t.Fatalf("EstimateMessages(tool call) = %d, want %d", got, want)
	}
}

func TestEstimateMessagesParts(t *testing.T) {
	// Array-form content counts text parts only; images add nothing.
	msgs := []api.Message{{
		Role: "user",
		Content: api.PartsContent(
			api.TextPart("abcd"),
			api.ImagePart("data:image/png;base64,AAAA"),
			api.TextPart("efgh"),
		),
	}}
	want := basePriming + perMessageOverhead + EstimateText("user") + EstimateText("abcdefgh")
	if got := EstimateMessages(msgs); got != want {
		t.Fatalf("EstimateMessages(parts) = %d, want %d", got, want)
	}
}

func TestEstimateChatRequest(t *testing.T) {
	if got := EstimateChatRequest(nil); got != 0 {
		t.Fatalf("EstimateChatRequest(nil) = %d, want 0", got)
	}
	msgs := []api.Message{{Role: "user", Content: api.TextContent("hello there")}}
	params := json.RawMessage(`{"type":"object","properties":{"city":{"type":"string"}}}`)
	req := &api.ChatRequest{
		Messages: msgs,
		Tools: []api.Tool{{
			Type: "function",
			Function: api.ToolFunction{
				Name:        "get_weather",
				Description: "Look up current weather",
				Parameters:  params,
			},
		}},
	}
	want := EstimateMessages(msgs) +
		EstimateText("get_weather") +
		EstimateText("Look up current weather") +
		EstimateText(string(params))
	if got := EstimateChatRequest(req); got != want {
		t.Fatalf("EstimateChatRequest = %d, want %d", got, want)
	}
	// Tools strictly increase the estimate.
	if EstimateChatRequest(req) <= EstimateChatRequest(&api.ChatRequest{Messages: msgs}) {
		t.Fatal("tools did not increase the estimate")
	}
}

func TestEstimateAnthropicMessages(t *testing.T) {
	input := json.RawMessage(`{"city":"Paris"}`)
	msgs := []anthropic.InputMessage{
		{Role: "user", Content: anthropic.TextBlockContent("what is the weather")},
		{Role: "assistant", Content: anthropic.BlocksContent(
			anthropic.ContentBlock{Type: "thinking", Thinking: "user wants weather"},
			anthropic.ContentBlock{Type: "text", Text: "checking"},
			anthropic.ContentBlock{Type: "tool_use", ID: "tu_1", Name: "get_weather", Input: input},
		)},
		{Role: "user", Content: anthropic.BlocksContent(
			anthropic.ContentBlock{Type: "tool_result", ToolUseID: "tu_1", Content: anthropic.TextToolResult("22C and sunny")},
		)},
	}
	tools := []anthropic.Tool{{
		Name:        "get_weather",
		Description: "Look up current weather",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}}

	want := basePriming +
		perMessageOverhead + EstimateText("system prompt") + // system
		perMessageOverhead + EstimateText("user") + EstimateText("what is the weather") +
		perMessageOverhead + EstimateText("assistant") +
		EstimateText("user wants weather") + EstimateText("checking") +
		EstimateText("get_weather") + EstimateText(string(input)) +
		perMessageOverhead + EstimateText("user") + EstimateText("22C and sunny") +
		EstimateText("get_weather") + EstimateText("Look up current weather") + EstimateText(`{"type":"object"}`)
	if got := EstimateAnthropicMessages("system prompt", msgs, tools); got != want {
		t.Fatalf("EstimateAnthropicMessages = %d, want %d", got, want)
	}

	// Monotonic in each dimension: dropping system/tools/messages lowers it.
	full := EstimateAnthropicMessages("system prompt", msgs, tools)
	if EstimateAnthropicMessages("", msgs, tools) >= full {
		t.Fatal("system prompt did not increase the estimate")
	}
	if EstimateAnthropicMessages("system prompt", msgs, nil) >= full {
		t.Fatal("tools did not increase the estimate")
	}
	if EstimateAnthropicMessages("system prompt", msgs[:1], tools) >= full {
		t.Fatal("extra messages did not increase the estimate")
	}
}

func TestEstimateAnthropicNestedToolResult(t *testing.T) {
	// tool_result may nest block lists; nested text must count.
	msgs := []anthropic.InputMessage{{
		Role: "user",
		Content: anthropic.BlocksContent(anthropic.ContentBlock{
			Type:      "tool_result",
			ToolUseID: "tu_1",
			Content: &anthropic.ToolResultValue{Blocks: []anthropic.ContentBlock{
				{Type: "text", Text: "line one"},
				{Type: "text", Text: "line two"},
			}},
		}),
	}}
	want := basePriming + perMessageOverhead + EstimateText("user") +
		EstimateText("line one") + EstimateText("line two")
	if got := EstimateAnthropicMessages("", msgs, nil); got != want {
		t.Fatalf("nested tool_result = %d, want %d", got, want)
	}

	// Unpriceable blocks (images, redacted_thinking) add nothing.
	imgMsgs := []anthropic.InputMessage{{
		Role: "user",
		Content: anthropic.BlocksContent(
			anthropic.ContentBlock{Type: "image", Source: &anthropic.Source{Type: "base64", MediaType: "image/png", Data: "AAAA"}},
			anthropic.ContentBlock{Type: "redacted_thinking", Data: "opaque"},
		),
	}}
	if got, want := EstimateAnthropicMessages("", imgMsgs, nil), basePriming+perMessageOverhead+EstimateText("user"); got != want {
		t.Fatalf("non-text blocks = %d, want %d", got, want)
	}
}
