package acp

import "encoding/json"

// ACP method and notification names.
const (
	MethodInitialize    = "initialize"
	MethodNewSession    = "session/new"
	MethodPrompt        = "session/prompt"
	MethodCancel        = "session/cancel" // notification
	MethodSessionUpdate = "session/update" // notification
)

// session/update discriminator values (the `sessionUpdate` field).
const (
	UpdateAgentMessageChunk = "agent_message_chunk"
	UpdateAgentThoughtChunk = "agent_thought_chunk"
	UpdateUserMessageChunk  = "user_message_chunk"
	UpdateToolCall          = "tool_call"
	UpdateToolCallUpdate    = "tool_call_update"
	UpdateAvailableCommands = "available_commands_update"
)

// session/prompt stop reasons.
const (
	StopEndTurn   = "end_turn"
	StopRefusal   = "refusal"
	StopCancelled = "cancelled"
)

// Tool-call status and kind values.
const (
	ToolStatusPending   = "pending"
	ToolStatusCompleted = "completed"
	ToolStatusFailed    = "failed"

	ToolKindRead    = "read"
	ToolKindEdit    = "edit"
	ToolKindExecute = "execute"
	ToolKindSearch  = "search"
	ToolKindFetch   = "fetch"
	ToolKindOther   = "other"
)

// Implementation identifies the agent or client software.
type Implementation struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version,omitempty"`
}

// ── initialize ────────────────────────────────────────────────────────────────

type InitializeParams struct {
	ProtocolVersion int             `json:"protocolVersion"`
	ClientInfo      *Implementation `json:"clientInfo,omitempty"`
}

type InitializeResult struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities `json:"agentCapabilities,omitempty"`
	AgentInfo         *Implementation   `json:"agentInfo,omitempty"`
	AuthMethods       []AuthMethod      `json:"authMethods"`
}

type AgentCapabilities struct {
	LoadSession        bool               `json:"loadSession,omitempty"`
	PromptCapabilities PromptCapabilities `json:"promptCapabilities,omitempty"`
}

type PromptCapabilities struct {
	Image           bool `json:"image,omitempty"`
	Audio           bool `json:"audio,omitempty"`
	EmbeddedContext bool `json:"embeddedContext,omitempty"`
}

type AuthMethod struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ── sessions ──────────────────────────────────────────────────────────────────

type NewSessionParams struct {
	Cwd        string      `json:"cwd"`
	MCPServers []MCPServer `json:"mcpServers"`
}

// MCPServer describes an MCP server the agent should connect for the session.
// Bandolier passes none; the fields are kept for round-tripping the request.
type MCPServer struct {
	Name    string   `json:"name"`
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
}

type NewSessionResult struct {
	SessionID string `json:"sessionId"`
}

type PromptParams struct {
	SessionID string         `json:"sessionId"`
	Prompt    []ContentBlock `json:"prompt"`
}

type PromptResult struct {
	StopReason string `json:"stopReason"`
}

// ── content ───────────────────────────────────────────────────────────────────

// ContentBlock is an ACP content block. Only the text variant is used today;
// other fields are present so non-text blocks round-trip without loss.
type ContentBlock struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	Data     string          `json:"data,omitempty"`
	MimeType string          `json:"mimeType,omitempty"`
	URI      string          `json:"uri,omitempty"`
	Resource json.RawMessage `json:"resource,omitempty"`
}

// TextBlock builds a text content block.
func TextBlock(s string) ContentBlock { return ContentBlock{Type: "text", Text: s} }

// ── session/update notification ───────────────────────────────────────────────

// SessionNotification is the params of a session/update notification. Update is
// one of the *Update structs below (tagged by its sessionUpdate field) when
// sending, or a raw object when receiving (decode via UpdateKind).
type SessionNotification struct {
	SessionID string `json:"sessionId"`
	Update    any    `json:"update"`
}

type AgentMessageChunk struct {
	SessionUpdate string       `json:"sessionUpdate"` // UpdateAgentMessageChunk
	MessageID     string       `json:"messageId,omitempty"`
	Content       ContentBlock `json:"content"`
}

type AgentThoughtChunk struct {
	SessionUpdate string       `json:"sessionUpdate"` // UpdateAgentThoughtChunk
	MessageID     string       `json:"messageId,omitempty"`
	Content       ContentBlock `json:"content"`
}

type ToolCall struct {
	SessionUpdate string          `json:"sessionUpdate"` // UpdateToolCall
	ToolCallID    string          `json:"toolCallId"`
	Title         string          `json:"title"`
	Kind          string          `json:"kind,omitempty"`
	Status        string          `json:"status"`
	RawInput      json.RawMessage `json:"rawInput,omitempty"`
}

type ToolCallUpdate struct {
	SessionUpdate string            `json:"sessionUpdate"` // UpdateToolCallUpdate
	ToolCallID    string            `json:"toolCallId"`
	Status        string            `json:"status,omitempty"`
	Content       []ToolCallContent `json:"content,omitempty"`
}

// ToolCallContent wraps a content block produced by a tool.
type ToolCallContent struct {
	Type    string       `json:"type"` // "content"
	Content ContentBlock `json:"content"`
}

// AvailableCommandsUpdate advertises the slash commands the session supports, so
// a client can offer a typeahead menu. The agent emits it once the underlying
// CLI reports its command set (e.g. claude's stream-json init event).
type AvailableCommandsUpdate struct {
	SessionUpdate     string             `json:"sessionUpdate"` // UpdateAvailableCommands
	AvailableCommands []AvailableCommand `json:"availableCommands"`
}

// AvailableCommand is one entry in an AvailableCommandsUpdate: the command name
// (without a leading slash) and a human-readable description for the menu.
type AvailableCommand struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// UpdateKind extracts the sessionUpdate discriminator from a raw update object,
// for receivers that need to switch on the variant before decoding it.
func UpdateKind(raw json.RawMessage) string {
	var probe struct {
		SessionUpdate string `json:"sessionUpdate"`
	}
	_ = json.Unmarshal(raw, &probe)
	return probe.SessionUpdate
}
