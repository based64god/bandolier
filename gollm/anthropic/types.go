// Package anthropic implements the Anthropic Messages API wire format and
// bidirectional translation to gollm's unified format. It is used from both
// directions:
//
//   - outbound: the anthropic provider adapter encodes unified requests into
//     this wire format and decodes Anthropic responses/streams back;
//   - inbound: the proxy's /v1/messages endpoint decodes requests in this
//     format (from clients like Claude Code) into unified requests, and
//     encodes unified responses/streams back into Anthropic responses and
//     SSE events.
//
// The inbound path is what lets Claude Code point ANTHROPIC_BASE_URL at a
// gollm proxy and transparently run on any configured backend.
package anthropic

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Version is the anthropic-version header value this package speaks.
const Version = "2023-06-01"

// MessagesRequest is POST /v1/messages. Unknown fields sent by newer clients
// are deliberately tolerated (ignored) rather than rejected.
type MessagesRequest struct {
	Model         string         `json:"model"`
	Messages      []InputMessage `json:"messages"`
	MaxTokens     int            `json:"max_tokens"`
	System        SystemPrompt   `json:"system,omitempty"`
	Metadata      *Metadata      `json:"metadata,omitempty"`
	StopSequences []string       `json:"stop_sequences,omitempty"`
	Stream        bool           `json:"stream,omitempty"`
	Temperature   *float64       `json:"temperature,omitempty"`
	TopK          *int           `json:"top_k,omitempty"`
	TopP          *float64       `json:"top_p,omitempty"`
	Tools         []Tool         `json:"tools,omitempty"`
	ToolChoice    *ToolChoice    `json:"tool_choice,omitempty"`
	Thinking      *Thinking      `json:"thinking,omitempty"`
	ServiceTier   string         `json:"service_tier,omitempty"`
}

// Metadata carries request metadata; user_id is the only defined field.
type Metadata struct {
	UserID string `json:"user_id,omitempty"`
}

// Thinking enables extended thinking with a token budget.
type Thinking struct {
	Type         string `json:"type"` // "enabled" | "disabled"
	BudgetTokens int    `json:"budget_tokens,omitempty"`
}

// SystemPrompt is a string or an array of text blocks (the array form carries
// cache_control markers).
type SystemPrompt struct {
	Text   string
	Blocks []ContentBlock
}

func (s SystemPrompt) IsZero() bool { return s.Text == "" && s.Blocks == nil }

// JoinedText flattens the prompt to plain text for backends without
// structured system prompts.
func (s SystemPrompt) JoinedText() string {
	if s.Blocks == nil {
		return s.Text
	}
	var parts []string
	for _, b := range s.Blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n\n")
}

func (s SystemPrompt) MarshalJSON() ([]byte, error) {
	if s.Blocks != nil {
		return json.Marshal(s.Blocks)
	}
	if s.Text == "" {
		return []byte("null"), nil
	}
	return json.Marshal(s.Text)
}

func (s *SystemPrompt) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	switch {
	case trimmed == "null":
		*s = SystemPrompt{}
		return nil
	case strings.HasPrefix(trimmed, "\""):
		return json.Unmarshal(data, &s.Text)
	case strings.HasPrefix(trimmed, "["):
		return json.Unmarshal(data, &s.Blocks)
	default:
		return fmt.Errorf("system must be a string or an array of blocks")
	}
}

// InputMessage is one conversation turn; content is a string or a block list.
type InputMessage struct {
	Role    string       `json:"role"` // "user" | "assistant"
	Content BlockContent `json:"content"`
}

// BlockContent is string-or-blocks polymorphic content.
type BlockContent struct {
	Text   string
	Blocks []ContentBlock
	isText bool
}

// TextBlockContent builds the plain-string form.
func TextBlockContent(s string) BlockContent { return BlockContent{Text: s, isText: true} }

// BlocksContent builds the array form.
func BlocksContent(blocks ...ContentBlock) BlockContent {
	if blocks == nil {
		blocks = []ContentBlock{}
	}
	return BlockContent{Blocks: blocks}
}

// AsBlocks normalizes to the array form (a plain string becomes one text
// block).
func (c BlockContent) AsBlocks() []ContentBlock {
	if c.Blocks != nil {
		return c.Blocks
	}
	if c.isText {
		return []ContentBlock{{Type: "text", Text: c.Text}}
	}
	return nil
}

func (c BlockContent) MarshalJSON() ([]byte, error) {
	if c.Blocks != nil {
		return json.Marshal(c.Blocks)
	}
	return json.Marshal(c.Text)
}

func (c *BlockContent) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	switch {
	case strings.HasPrefix(trimmed, "\""):
		c.Blocks = nil
		c.isText = true
		return json.Unmarshal(data, &c.Text)
	case strings.HasPrefix(trimmed, "["):
		c.isText = false
		return json.Unmarshal(data, &c.Blocks)
	case trimmed == "null":
		*c = BlockContent{}
		return nil
	default:
		return fmt.Errorf("message content must be a string or an array of blocks")
	}
}

// ContentBlock is the Messages API content union. Type selects which fields
// are meaningful. CacheControl is tolerated on any block (Claude Code marks
// cache breakpoints); it round-trips to Anthropic backends and is dropped by
// translation to others.
type ContentBlock struct {
	Type string `json:"type"`

	// text
	Text string `json:"text,omitempty"`

	// image / document
	Source *Source `json:"source,omitempty"`
	Title  string  `json:"title,omitempty"`

	// tool_use (and server_tool_use)
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`

	// tool_result
	ToolUseID string           `json:"tool_use_id,omitempty"`
	Content   *ToolResultValue `json:"content,omitempty"`
	IsError   bool             `json:"is_error,omitempty"`

	// thinking
	Thinking  string `json:"thinking,omitempty"`
	Signature string `json:"signature,omitempty"`

	// redacted_thinking
	Data string `json:"data,omitempty"`

	CacheControl *CacheControl `json:"cache_control,omitempty"`
}

// CacheControl marks a prompt-cache breakpoint.
type CacheControl struct {
	Type string `json:"type"` // "ephemeral"
	TTL  string `json:"ttl,omitempty"`
}

// Source is an image/document payload: base64-inline or URL.
type Source struct {
	Type      string `json:"type"` // "base64" | "url" | "text"
	MediaType string `json:"media_type,omitempty"`
	Data      string `json:"data,omitempty"`
	URL       string `json:"url,omitempty"`
}

// ToolResultValue is tool_result content: a string or nested blocks.
type ToolResultValue struct {
	Text   string
	Blocks []ContentBlock
	isText bool
}

func TextToolResult(s string) *ToolResultValue { return &ToolResultValue{Text: s, isText: true} }

// JoinedText flattens tool-result content to plain text.
func (v *ToolResultValue) JoinedText() string {
	if v == nil {
		return ""
	}
	if v.Blocks == nil {
		return v.Text
	}
	var parts []string
	for _, b := range v.Blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func (v ToolResultValue) MarshalJSON() ([]byte, error) {
	if v.Blocks != nil {
		return json.Marshal(v.Blocks)
	}
	return json.Marshal(v.Text)
}

func (v *ToolResultValue) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	switch {
	case strings.HasPrefix(trimmed, "\""):
		v.Blocks = nil
		v.isText = true
		return json.Unmarshal(data, &v.Text)
	case strings.HasPrefix(trimmed, "["):
		v.isText = false
		return json.Unmarshal(data, &v.Blocks)
	case trimmed == "null":
		*v = ToolResultValue{}
		return nil
	default:
		return fmt.Errorf("tool_result content must be a string or an array of blocks")
	}
}

// Tool is an Anthropic tool declaration. Client tools have no Type (or
// "custom"); server tools (web_search_20250305, computer_20250124, ...) carry
// a versioned Type and cannot be translated to non-Anthropic backends.
type Tool struct {
	Type         string          `json:"type,omitempty"`
	Name         string          `json:"name"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"input_schema,omitempty"`
	CacheControl *CacheControl   `json:"cache_control,omitempty"`

	// Server-tool fields (tolerated, passed through to Anthropic backends).
	MaxUses         *int            `json:"max_uses,omitempty"`
	AllowedDomains  []string        `json:"allowed_domains,omitempty"`
	BlockedDomains  []string        `json:"blocked_domains,omitempty"`
	DisplayWidthPx  *int            `json:"display_width_px,omitempty"`
	DisplayHeightPx *int            `json:"display_height_px,omitempty"`
	DisplayNumber   *int            `json:"display_number,omitempty"`
	UserLocation    json.RawMessage `json:"user_location,omitempty"`
}

// IsClientTool reports whether the tool is a plain function-style tool that
// can be translated to other providers.
func (t Tool) IsClientTool() bool {
	return t.Type == "" || t.Type == "custom"
}

// ToolChoice is Anthropic's tool_choice union.
type ToolChoice struct {
	Type                   string `json:"type"` // "auto" | "any" | "tool" | "none"
	Name                   string `json:"name,omitempty"`
	DisableParallelToolUse *bool  `json:"disable_parallel_tool_use,omitempty"`
}

// MessagesResponse is the non-streaming /v1/messages response.
type MessagesResponse struct {
	ID           string         `json:"id"`
	Type         string         `json:"type"` // "message"
	Role         string         `json:"role"` // "assistant"
	Model        string         `json:"model"`
	Content      []ContentBlock `json:"content"`
	StopReason   string         `json:"stop_reason,omitempty"`
	StopSequence *string        `json:"stop_sequence,omitempty"`
	Usage        *Usage         `json:"usage,omitempty"`
}

// Usage is Anthropic's token accounting.
type Usage struct {
	InputTokens              int    `json:"input_tokens"`
	OutputTokens             int    `json:"output_tokens"`
	CacheCreationInputTokens int    `json:"cache_creation_input_tokens,omitempty"`
	CacheReadInputTokens     int    `json:"cache_read_input_tokens,omitempty"`
	ServiceTier              string `json:"service_tier,omitempty"`
}

// CountTokensRequest is POST /v1/messages/count_tokens (same shape as a
// MessagesRequest minus generation parameters).
type CountTokensRequest struct {
	Model      string         `json:"model"`
	Messages   []InputMessage `json:"messages"`
	System     SystemPrompt   `json:"system,omitempty"`
	Tools      []Tool         `json:"tools,omitempty"`
	ToolChoice *ToolChoice    `json:"tool_choice,omitempty"`
	Thinking   *Thinking      `json:"thinking,omitempty"`
}

type CountTokensResponse struct {
	InputTokens int `json:"input_tokens"`
}

// ErrorResponse is Anthropic's error envelope.
type ErrorResponse struct {
	Type  string      `json:"type"` // "error"
	Error ErrorDetail `json:"error"`
}

type ErrorDetail struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// ── Streaming events ────────────────────────────────────────────────────────

// StreamEvent is one SSE event on a Messages stream, decoded generically;
// only the fields matching Type are set.
type StreamEvent struct {
	Type string `json:"type"`

	// message_start
	Message *MessagesResponse `json:"message,omitempty"`

	// content_block_start / content_block_delta / content_block_stop
	Index        *int          `json:"index,omitempty"`
	ContentBlock *ContentBlock `json:"content_block,omitempty"`
	Delta        *EventDelta   `json:"delta,omitempty"`

	// message_delta
	Usage *Usage `json:"usage,omitempty"`

	// error
	Error *ErrorDetail `json:"error,omitempty"`
}

// EventDelta is the polymorphic delta payload: content_block_delta carries
// one of the *_delta variants; message_delta carries stop_reason /
// stop_sequence.
type EventDelta struct {
	Type string `json:"type,omitempty"`

	// text_delta
	Text string `json:"text,omitempty"`
	// input_json_delta
	PartialJSON string `json:"partial_json,omitempty"`
	// thinking_delta
	Thinking string `json:"thinking,omitempty"`
	// signature_delta
	Signature string `json:"signature,omitempty"`

	// message_delta
	StopReason   string  `json:"stop_reason,omitempty"`
	StopSequence *string `json:"stop_sequence,omitempty"`
}
