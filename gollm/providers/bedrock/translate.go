package bedrock

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

// defaultMaxTokens is applied when the caller sets no limit — Converse
// requires maxTokens (litellm uses the same default).
const defaultMaxTokens = 4096

// ── Converse wire types ──

type converseRequest struct {
	Messages        []converseMessage `json:"messages"`
	System          []systemBlock     `json:"system,omitempty"`
	InferenceConfig *inferenceConfig  `json:"inferenceConfig,omitempty"`
	ToolConfig      *toolConfig       `json:"toolConfig,omitempty"`
}

type systemBlock struct {
	Text string `json:"text"`
}

type converseMessage struct {
	Role    string         `json:"role"`
	Content []contentBlock `json:"content"`
}

// contentBlock is Converse's content union; exactly one field is set. Text is
// a pointer so response decoding can tell a text block from the other arms.
type contentBlock struct {
	Text             *string          `json:"text,omitempty"`
	Image            *imageBlock      `json:"image,omitempty"`
	ToolUse          *toolUseBlock    `json:"toolUse,omitempty"`
	ToolResult       *toolResultBlock `json:"toolResult,omitempty"`
	ReasoningContent *reasoningBlock  `json:"reasoningContent,omitempty"`
}

type imageBlock struct {
	Format string      `json:"format"` // png | jpeg | gif | webp
	Source imageSource `json:"source"`
}

type imageSource struct {
	Bytes string `json:"bytes"` // base64 (JSON encoding of the blob type)
}

type toolUseBlock struct {
	ToolUseID string          `json:"toolUseId"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
}

type toolResultBlock struct {
	ToolUseID string         `json:"toolUseId"`
	Content   []contentBlock `json:"content"`
}

type reasoningBlock struct {
	ReasoningText *reasoningText `json:"reasoningText,omitempty"`
}

type reasoningText struct {
	Text string `json:"text"`
}

type inferenceConfig struct {
	MaxTokens     int      `json:"maxTokens"`
	Temperature   *float64 `json:"temperature,omitempty"`
	TopP          *float64 `json:"topP,omitempty"`
	StopSequences []string `json:"stopSequences,omitempty"`
}

type toolConfig struct {
	Tools      []toolEntry         `json:"tools"`
	ToolChoice *converseToolChoice `json:"toolChoice,omitempty"`
}

type toolEntry struct {
	ToolSpec toolSpec `json:"toolSpec"`
}

type toolSpec struct {
	Name        string       `json:"name"`
	Description string       `json:"description,omitempty"`
	InputSchema schemaHolder `json:"inputSchema"`
}

type schemaHolder struct {
	JSON json.RawMessage `json:"json"`
}

// converseToolChoice is the {auto:{}} | {any:{}} | {tool:{name}} union.
type converseToolChoice struct {
	Auto *struct{}     `json:"auto,omitempty"`
	Any  *struct{}     `json:"any,omitempty"`
	Tool *toolChoiceFn `json:"tool,omitempty"`
}

type toolChoiceFn struct {
	Name string `json:"name"`
}

type converseResponse struct {
	Output struct {
		Message converseMessage `json:"message"`
	} `json:"output"`
	StopReason string         `json:"stopReason"`
	Usage      *converseUsage `json:"usage"`
}

type converseUsage struct {
	InputTokens           int `json:"inputTokens"`
	OutputTokens          int `json:"outputTokens"`
	TotalTokens           int `json:"totalTokens"`
	CacheReadInputTokens  int `json:"cacheReadInputTokens"`
	CacheWriteInputTokens int `json:"cacheWriteInputTokens"`
}

// ── Request translation ──

// marshalConverse translates a unified request into a Converse body. Extra
// keys are merged verbatim at the top level (guardrailConfig,
// additionalModelRequestFields, ...), overriding typed fields on collision.
func marshalConverse(req *api.ChatRequest) ([]byte, error) {
	raw, err := json.Marshal(translateRequest(req))
	if err != nil {
		return nil, err
	}
	if len(req.Extra) == 0 {
		return raw, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	for k, v := range req.Extra {
		m[k] = v
	}
	return json.Marshal(m)
}

func translateRequest(req *api.ChatRequest) *converseRequest {
	out := &converseRequest{}

	for _, m := range req.Messages {
		switch m.Role {
		case "system", "developer":
			// System prompts move to the top-level system list regardless of
			// position; Converse has no in-band system turns.
			out.System = append(out.System, systemBlock{Text: m.Content.AsText()})
		case "assistant":
			appendMessage(out, "assistant", assistantBlocks(m))
		case "tool", "function":
			appendMessage(out, "user", []contentBlock{{ToolResult: &toolResultBlock{
				ToolUseID: m.ToolCallID,
				Content:   []contentBlock{textContentBlock(m.Content.AsText())},
			}}})
		default: // user
			appendMessage(out, "user", userBlocks(m))
		}
	}

	maxTokens := defaultMaxTokens
	if req.MaxTokens != nil {
		maxTokens = *req.MaxTokens
	} else if req.MaxCompletionTokens != nil {
		maxTokens = *req.MaxCompletionTokens
	}
	out.InferenceConfig = &inferenceConfig{
		MaxTokens:     maxTokens,
		Temperature:   req.Temperature,
		TopP:          req.TopP,
		StopSequences: req.Stop,
	}

	// tool_choice "none" has no Converse spelling: drop the tools instead so
	// the model can't call them, mirroring litellm.
	if len(req.Tools) > 0 && (req.ToolChoice == nil || req.ToolChoice.Mode != "none") {
		tc := &toolConfig{}
		for _, t := range req.Tools {
			schema := t.Function.Parameters
			if len(schema) == 0 {
				// Converse requires a schema object; OpenAI allows omitting it.
				schema = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			tc.Tools = append(tc.Tools, toolEntry{ToolSpec: toolSpec{
				Name:        t.Function.Name,
				Description: t.Function.Description,
				InputSchema: schemaHolder{JSON: schema},
			}})
		}
		if req.ToolChoice != nil {
			switch req.ToolChoice.Mode {
			case "auto":
				tc.ToolChoice = &converseToolChoice{Auto: &struct{}{}}
			case "required":
				tc.ToolChoice = &converseToolChoice{Any: &struct{}{}}
			case "function":
				tc.ToolChoice = &converseToolChoice{Tool: &toolChoiceFn{Name: req.ToolChoice.FunctionName}}
			}
		}
		out.ToolConfig = tc
	}
	return out
}

// appendMessage merges into the previous message when roles match — Converse
// requires strict user/assistant alternation, and tool results become user
// turns that must coalesce with adjacent user text.
func appendMessage(out *converseRequest, role string, blocks []contentBlock) {
	if len(blocks) == 0 {
		return
	}
	if n := len(out.Messages); n > 0 && out.Messages[n-1].Role == role {
		out.Messages[n-1].Content = append(out.Messages[n-1].Content, blocks...)
		return
	}
	out.Messages = append(out.Messages, converseMessage{Role: role, Content: blocks})
}

func textContentBlock(s string) contentBlock {
	return contentBlock{Text: &s}
}

func userBlocks(m api.Message) []contentBlock {
	if m.Content.Parts == nil {
		if s := m.Content.AsText(); s != "" {
			return []contentBlock{textContentBlock(s)}
		}
		return nil
	}
	var blocks []contentBlock
	for _, p := range m.Content.Parts {
		switch p.Type {
		case "text":
			blocks = append(blocks, textContentBlock(p.Text))
		case "image_url":
			// Converse has no URL image source; only inline data URIs
			// translate, anything else is dropped (drop_params semantics).
			if p.ImageURL != nil {
				if img := imageFromDataURI(p.ImageURL.URL); img != nil {
					blocks = append(blocks, contentBlock{Image: img})
				}
			}
		}
	}
	return blocks
}

func assistantBlocks(m api.Message) []contentBlock {
	var blocks []contentBlock
	if s := m.Content.AsText(); s != "" {
		blocks = append(blocks, textContentBlock(s))
	}
	for _, tc := range m.ToolCalls {
		// toolUse.input is a JSON object, not the OpenAI argument string;
		// embed the raw bytes when valid, else fall back to an empty object.
		input := json.RawMessage(tc.Function.Arguments)
		if len(input) == 0 || !json.Valid(input) {
			input = json.RawMessage("{}")
		}
		blocks = append(blocks, contentBlock{ToolUse: &toolUseBlock{
			ToolUseID: tc.ID,
			Name:      tc.Function.Name,
			Input:     input,
		}})
	}
	return blocks
}

// imageFromDataURI converts a base64 data URI ("data:image/png;base64,...")
// into a Converse image block; anything else returns nil.
func imageFromDataURI(uri string) *imageBlock {
	rest, ok := strings.CutPrefix(uri, "data:")
	if !ok {
		return nil
	}
	meta, data, ok := strings.Cut(rest, ",")
	if !ok || !strings.Contains(meta, "base64") {
		return nil
	}
	mediaType, _, _ := strings.Cut(meta, ";")
	format, ok := strings.CutPrefix(mediaType, "image/")
	if !ok {
		return nil
	}
	if format == "jpg" {
		format = "jpeg"
	}
	return &imageBlock{Format: format, Source: imageSource{Bytes: data}}
}

// ── Response translation ──

func responseToUnified(cr *converseResponse, model string) *api.ChatResponse {
	msg := api.Message{Role: "assistant"}
	var text strings.Builder
	sawText := false
	for _, b := range cr.Output.Message.Content {
		switch {
		case b.Text != nil:
			text.WriteString(*b.Text)
			sawText = true
		case b.ToolUse != nil:
			msg.ToolCalls = append(msg.ToolCalls, api.ToolCall{
				ID:   b.ToolUse.ToolUseID,
				Type: "function",
				Function: api.ToolCallFunction{
					Name:      b.ToolUse.Name,
					Arguments: string(b.ToolUse.Input),
				},
			})
		case b.ReasoningContent != nil && b.ReasoningContent.ReasoningText != nil:
			msg.ReasoningContent += b.ReasoningContent.ReasoningText.Text
		}
	}
	if sawText {
		msg.Content = api.TextContent(text.String())
	}

	return &api.ChatResponse{
		ID:       newID(),
		Object:   "chat.completion",
		Created:  time.Now().Unix(),
		Model:    model,
		Provider: "bedrock",
		Choices: []api.Choice{{
			Message:      msg,
			FinishReason: mapStopReason(cr.StopReason),
		}},
		Usage: usageToUnified(cr.Usage),
	}
}

// mapStopReason translates Converse stopReason values to OpenAI finish
// reasons; unknown values default to "stop" (litellm's map_finish_reason).
func mapStopReason(s string) string {
	switch s {
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	case "content_filtered", "guardrail_intervened":
		return "content_filter"
	default: // end_turn, stop_sequence, unknown
		return "stop"
	}
}

// usageToUnified maps Converse usage. Bedrock's inputTokens excludes cache
// reads/writes; they are folded into prompt_tokens (as litellm does) so cost
// accounting sees the whole prompt, with the split in the details block.
func usageToUnified(u *converseUsage) *api.Usage {
	if u == nil {
		return nil
	}
	out := &api.Usage{
		PromptTokens:     u.InputTokens + u.CacheReadInputTokens + u.CacheWriteInputTokens,
		CompletionTokens: u.OutputTokens,
		TotalTokens:      u.TotalTokens,
	}
	if u.CacheReadInputTokens != 0 || u.CacheWriteInputTokens != 0 {
		out.PromptTokensDetails = &api.PromptTokensDetails{
			CachedTokens:        u.CacheReadInputTokens,
			CacheCreationTokens: u.CacheWriteInputTokens,
		}
	}
	return out
}

// newID fabricates an OpenAI-style response id; Converse responses carry none.
func newID() string {
	var b [12]byte
	rand.Read(b[:])
	return "chatcmpl-" + hex.EncodeToString(b[:])
}
