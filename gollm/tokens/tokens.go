// Package tokens estimates token counts without a tokenizer. The heuristic is
// the classic bytes/4 rule: modern BPE vocabularies (GPT, Claude) average
// ~4 bytes per token on English prose. That keeps gollm dependency-free at
// the cost of accuracy — expect ±30% on code, dense JSON, or non-Latin
// scripts — so estimates are for pre-flight budgeting and the proxy's
// count_tokens endpoint; use provider-reported usage wherever it exists.
package tokens

import (
	"github.com/based64god/gollm/anthropic"
	"github.com/based64god/gollm/api"
)

// Chat-format framing constants, from OpenAI's published accounting: each
// message costs ~4 tokens of scaffolding (<|im_start|>role\n…<|im_end|>) and
// every reply is primed with ~3.
const (
	perMessageOverhead = 4
	basePriming        = 3
)

// EstimateText approximates the BPE token count of s as ceil(len/4); any
// non-empty string counts at least 1.
func EstimateText(s string) int {
	if len(s) == 0 {
		return 0
	}
	return (len(s) + 3) / 4
}

// EstimateMessages estimates prompt tokens for a unified conversation: role,
// text content, and tool-call text per message, plus per-message framing
// overhead and the base reply priming. Non-text parts (images, audio) are
// not counted — they are priced by provider-specific rules this heuristic
// cannot approximate.
func EstimateMessages(msgs []api.Message) int {
	n := basePriming
	for _, m := range msgs {
		n += perMessageOverhead
		n += EstimateText(m.Role)
		n += EstimateText(m.Content.AsText())
		for _, tc := range m.ToolCalls {
			n += EstimateText(tc.Function.Name)
			n += EstimateText(tc.Function.Arguments)
		}
	}
	return n
}

// EstimateChatRequest estimates prompt tokens for a whole request: the
// messages plus each tool declaration (name, description, and the raw
// parameters JSON schema all occupy the prompt on every provider).
func EstimateChatRequest(req *api.ChatRequest) int {
	if req == nil {
		return 0
	}
	n := EstimateMessages(req.Messages)
	for _, t := range req.Tools {
		n += EstimateText(t.Function.Name)
		n += EstimateText(t.Function.Description)
		n += EstimateText(string(t.Function.Parameters))
	}
	return n
}

// EstimateAnthropicMessages estimates input tokens for an Anthropic-format
// request — the proxy's /v1/messages/count_tokens fallback when the backend
// has no native counter. It walks every content block, counting the textual
// fields each type carries (tool_use input JSON, tool_result payloads,
// thinking traces); images, documents, and signatures are skipped.
func EstimateAnthropicMessages(system string, msgs []anthropic.InputMessage, tools []anthropic.Tool) int {
	n := basePriming
	if system != "" {
		n += perMessageOverhead + EstimateText(system)
	}
	for _, m := range msgs {
		n += perMessageOverhead
		n += EstimateText(m.Role)
		for _, b := range m.Content.AsBlocks() {
			n += estimateBlock(b)
		}
	}
	for _, t := range tools {
		n += EstimateText(t.Name)
		n += EstimateText(t.Description)
		n += EstimateText(string(t.InputSchema))
	}
	return n
}

func estimateBlock(b anthropic.ContentBlock) int {
	switch b.Type {
	case "text":
		return EstimateText(b.Text)
	case "tool_use", "server_tool_use":
		return EstimateText(b.Name) + EstimateText(string(b.Input))
	case "tool_result":
		if b.Content == nil {
			return 0
		}
		if b.Content.Blocks == nil {
			return EstimateText(b.Content.Text)
		}
		n := 0
		for _, nested := range b.Content.Blocks {
			n += estimateBlock(nested)
		}
		return n
	case "thinking":
		return EstimateText(b.Thinking)
	default:
		// image, document, redacted_thinking, …: no text to price.
		return 0
	}
}
