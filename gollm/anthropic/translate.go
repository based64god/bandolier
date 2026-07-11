package anthropic

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/based64god/gollm/api"
)

// DefaultMaxTokens is used when a unified request doesn't set max_tokens —
// the Messages API requires one (litellm defaults the same way).
const DefaultMaxTokens = 4096

// ── stop_reason ↔ finish_reason ─────────────────────────────────────────────

// StopReasonToFinish maps Anthropic stop_reason → OpenAI finish_reason.
func StopReasonToFinish(stop string) string {
	switch stop {
	case "end_turn", "stop_sequence", "pause_turn":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	case "refusal":
		return "content_filter"
	case "":
		return ""
	default:
		return "stop"
	}
}

// FinishToStopReason maps OpenAI finish_reason → Anthropic stop_reason.
func FinishToStopReason(finish string) string {
	switch finish {
	case "stop":
		return "end_turn"
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	case "content_filter":
		return "refusal"
	case "":
		return ""
	default:
		return "end_turn"
	}
}

// ── usage ───────────────────────────────────────────────────────────────────

// UsageToUnified converts Anthropic usage (input tokens exclude cache reads/
// writes, which are reported separately) into OpenAI-shaped usage (prompt
// tokens include everything, with cache reads detailed).
func UsageToUnified(u *Usage) *api.Usage {
	if u == nil {
		return nil
	}
	prompt := u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
	out := &api.Usage{
		PromptTokens:     prompt,
		CompletionTokens: u.OutputTokens,
		TotalTokens:      prompt + u.OutputTokens,
	}
	if u.CacheReadInputTokens > 0 || u.CacheCreationInputTokens > 0 {
		out.PromptTokensDetails = &api.PromptTokensDetails{
			CachedTokens:        u.CacheReadInputTokens,
			CacheCreationTokens: u.CacheCreationInputTokens,
		}
	}
	return out
}

// UsageFromUnified converts OpenAI-shaped usage into Anthropic usage.
func UsageFromUnified(u *api.Usage) *Usage {
	if u == nil {
		return nil
	}
	out := &Usage{
		InputTokens:  u.PromptTokens,
		OutputTokens: u.CompletionTokens,
	}
	if d := u.PromptTokensDetails; d != nil {
		out.CacheReadInputTokens = d.CachedTokens
		out.CacheCreationInputTokens = d.CacheCreationTokens
		// Anthropic's input_tokens exclude cached/cache-written tokens.
		out.InputTokens -= d.CachedTokens + d.CacheCreationTokens
		if out.InputTokens < 0 {
			out.InputTokens = 0
		}
	}
	return out
}

// ── inbound: Anthropic request → unified ────────────────────────────────────

// validToolName is OpenAI's function-name constraint; Anthropic imposes no
// length limit, so MCP tool names ("mcp__server__tool...") can exceed it.
var validToolName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// sanitizeToolName maps a tool name onto OpenAI's ^[a-zA-Z0-9_-]{1,64}$.
// Conforming names pass through unchanged. Anything else keeps a recognizable
// prefix and gains a hash suffix of the full original name, so distinct long
// names stay distinct and the mapping is deterministic across request/response.
func sanitizeToolName(name string) string {
	if validToolName.MatchString(name) {
		return name
	}
	cleaned := make([]byte, 0, len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
			cleaned = append(cleaned, c)
		default:
			cleaned = append(cleaned, '_')
		}
	}
	// prefix(≤55) + "_" + 8 hex = ≤64.
	if len(cleaned) > 55 {
		cleaned = cleaned[:55]
	}
	if len(cleaned) == 0 {
		cleaned = []byte("tool")
	}
	sum := sha256.Sum256([]byte(name))
	return string(cleaned) + "_" + hex.EncodeToString(sum[:4])
}

// RequestToUnified converts an inbound Messages API request (e.g. from Claude
// Code) into a unified request. Anthropic-only concepts degrade gracefully:
// cache_control markers are dropped, thinking config maps onto
// reasoning_effort, server tools are skipped (they cannot execute off
// Anthropic infrastructure), thinking blocks in history become
// reasoning context.
func RequestToUnified(mreq *MessagesRequest) (*api.ChatRequest, error) {
	req, _, err := RequestToUnifiedWithTools(mreq)
	return req, err
}

// RequestToUnifiedWithTools is RequestToUnified plus the tool-name map
// (sanitized → original) recording every name that had to be rewritten to
// satisfy OpenAI's function-name constraint. Pass the map to
// ResponseFromUnifiedNamed / NewEncodeStateWithNames so the client sees its
// original names in tool_use blocks (Claude Code matches tools by name).
func RequestToUnifiedWithTools(mreq *MessagesRequest) (*api.ChatRequest, map[string]string, error) {
	req := &api.ChatRequest{
		Model:       mreq.Model,
		Temperature: mreq.Temperature,
		TopP:        mreq.TopP,
		Stream:      mreq.Stream,
	}
	if mreq.MaxTokens > 0 {
		mt := mreq.MaxTokens
		req.MaxTokens = &mt
	}
	if len(mreq.StopSequences) > 0 {
		req.Stop = append(api.StringOrSlice{}, mreq.StopSequences...)
	}
	if mreq.Metadata != nil {
		req.User = mreq.Metadata.UserID
	}
	if mreq.TopK != nil {
		// No unified slot; forward for providers that accept it natively.
		if req.Extra == nil {
			req.Extra = map[string]any{}
		}
		req.Extra["top_k"] = *mreq.TopK
	}

	if !mreq.System.IsZero() {
		if sys := mreq.System.JoinedText(); sys != "" {
			req.Messages = append(req.Messages, api.Message{
				Role:    "system",
				Content: api.TextContent(sys),
			})
		}
	}

	for i, m := range mreq.Messages {
		msgs, err := inputMessageToUnified(m)
		if err != nil {
			return nil, nil, fmt.Errorf("messages[%d]: %w", i, err)
		}
		req.Messages = append(req.Messages, msgs...)
	}

	names := map[string]string{}
	for _, t := range mreq.Tools {
		if !t.IsClientTool() {
			// Server tools run on Anthropic infrastructure; there is nothing
			// equivalent to call on another backend.
			continue
		}
		name := sanitizeToolName(t.Name)
		if name != t.Name {
			names[name] = t.Name
		}
		req.Tools = append(req.Tools, api.Tool{
			Type: "function",
			Function: api.ToolFunction{
				Name:        name,
				Description: t.Description,
				Parameters:  t.InputSchema,
			},
		})
	}

	if tc := mreq.ToolChoice; tc != nil {
		switch tc.Type {
		case "auto":
			req.ToolChoice = api.ToolChoiceAuto()
		case "any":
			req.ToolChoice = api.ToolChoiceRequired()
		case "none":
			req.ToolChoice = api.ToolChoiceNone()
		case "tool":
			req.ToolChoice = api.ToolChoiceFunction(sanitizeToolName(tc.Name))
		}
		if tc.DisableParallelToolUse != nil {
			parallel := !*tc.DisableParallelToolUse
			req.ParallelToolCalls = &parallel
		}
	}

	if th := mreq.Thinking; th != nil && th.Type == "enabled" {
		req.ReasoningEffort = effortFromBudget(th.BudgetTokens)
	}

	return req, names, nil
}

// effortFromBudget buckets a thinking token budget into OpenAI's
// reasoning_effort scale.
func effortFromBudget(budget int) string {
	switch {
	case budget <= 0:
		return "medium"
	case budget < 4096:
		return "low"
	case budget < 16384:
		return "medium"
	default:
		return "high"
	}
}

// BudgetFromEffort is the inverse mapping, used when encoding unified
// requests for Anthropic backends.
func BudgetFromEffort(effort string) int {
	switch effort {
	case "minimal", "low":
		return 1024
	case "medium":
		return 8192
	case "high":
		return 16384
	case "xhigh", "max":
		return 32768
	default:
		return 8192
	}
}

// inputMessageToUnified expands one Anthropic message into unified messages.
// Anthropic packs tool results as content blocks of a user message; OpenAI
// represents each as its own tool-role message that must directly follow the
// assistant turn — so tool_result blocks are emitted first, then remaining
// content as a user message.
func inputMessageToUnified(m InputMessage) ([]api.Message, error) {
	blocks := m.Content.AsBlocks()

	switch m.Role {
	case "system":
		// Claude Code injects system-role messages into the messages array
		// (context reminders and the like), beyond the top-level system field.
		// OpenAI's format allows system messages anywhere, so map them through
		// with their text content.
		var text strings.Builder
		for _, b := range blocks {
			if b.Type == "text" {
				text.WriteString(b.Text)
			}
		}
		return []api.Message{{Role: "system", Content: api.TextContent(text.String())}}, nil

	case "user":
		var out []api.Message
		var parts []api.ContentPart
		for _, b := range blocks {
			switch b.Type {
			case "tool_result":
				out = append(out, api.Message{
					Role:       "tool",
					ToolCallID: b.ToolUseID,
					Content:    api.TextContent(toolResultText(b)),
				})
				// OpenAI tool-role messages carry only text; nested image
				// blocks ride on the following user message instead of being
				// dropped (litellm's approach).
				if b.Content != nil {
					for _, nb := range b.Content.Blocks {
						if nb.Type != "image" {
							continue
						}
						part, err := imageBlockToPart(nb)
						if err != nil {
							return nil, err
						}
						parts = append(parts, part)
					}
				}
			case "text":
				parts = append(parts, api.TextPart(b.Text))
			case "image":
				part, err := imageBlockToPart(b)
				if err != nil {
					return nil, err
				}
				parts = append(parts, part)
			case "document":
				// No cross-provider document primitive; degrade to its title,
				// or a placeholder — never drop the block silently.
				if b.Title != "" {
					parts = append(parts, api.TextPart(fmt.Sprintf("[document: %s]", b.Title)))
				} else {
					parts = append(parts, api.TextPart("[document]"))
				}
			default:
				// Unknown block types from newer clients are skipped, not
				// fatal — the rest of the conversation still translates.
			}
		}
		if len(parts) > 0 {
			msg := api.Message{Role: "user"}
			if len(parts) == 1 && parts[0].Type == "text" {
				msg.Content = api.TextContent(parts[0].Text)
			} else {
				msg.Content = api.PartsContent(parts...)
			}
			out = append(out, msg)
		}
		if len(out) == 0 {
			// A user turn that translated to nothing (e.g. only unknown
			// blocks) still needs to exist to keep alternation sane.
			out = append(out, api.Message{Role: "user", Content: api.TextContent("")})
		}
		return out, nil

	case "assistant":
		msg := api.Message{Role: "assistant"}
		var text strings.Builder
		var reasoning strings.Builder
		for _, b := range blocks {
			switch b.Type {
			case "text":
				text.WriteString(b.Text)
			case "thinking":
				reasoning.WriteString(b.Thinking)
				if b.Signature != "" {
					msg.ReasoningSignature = b.Signature
				}
			case "redacted_thinking":
				// Opaque to other providers; drop.
			case "tool_use":
				args := "{}"
				if len(b.Input) > 0 {
					args = string(b.Input)
				}
				msg.ToolCalls = append(msg.ToolCalls, api.ToolCall{
					ID:   b.ID,
					Type: "function",
					Function: api.ToolCallFunction{
						// History must reference tools by the same (sanitized)
						// name the declarations carry.
						Name:      sanitizeToolName(b.Name),
						Arguments: args,
					},
				})
			}
		}
		if text.Len() > 0 {
			msg.Content = api.TextContent(text.String())
		}
		msg.ReasoningContent = reasoning.String()
		return []api.Message{msg}, nil

	default:
		return nil, fmt.Errorf("unsupported role %q", m.Role)
	}
}

func toolResultText(b ContentBlock) string {
	text := b.Content.JoinedText()
	if b.IsError && text == "" {
		return "tool execution failed"
	}
	return text
}

func imageBlockToPart(b ContentBlock) (api.ContentPart, error) {
	if b.Source == nil {
		return api.ContentPart{}, fmt.Errorf("image block missing source")
	}
	switch b.Source.Type {
	case "base64":
		uri := fmt.Sprintf("data:%s;base64,%s", b.Source.MediaType, b.Source.Data)
		return api.ImagePart(uri), nil
	case "url":
		return api.ImagePart(b.Source.URL), nil
	default:
		return api.ContentPart{}, fmt.Errorf("unsupported image source type %q", b.Source.Type)
	}
}

// ── inbound: unified response → Anthropic response ──────────────────────────

// ResponseFromUnified converts a unified response into a Messages API
// response for Anthropic-format clients. Only choice 0 is used (the Messages
// API has no n>1). Tool-call arguments that fail to parse as JSON objects are
// wrapped rather than dropped, so the client still sees the invocation.
func ResponseFromUnified(resp *api.ChatResponse) *MessagesResponse {
	return ResponseFromUnifiedNamed(resp, nil)
}

// ResponseFromUnifiedNamed is ResponseFromUnified with tool_use names
// restored through the sanitized→original map from RequestToUnifiedWithTools.
func ResponseFromUnifiedNamed(resp *api.ChatResponse, names map[string]string) *MessagesResponse {
	out := &MessagesResponse{
		ID:    resp.ID,
		Type:  "message",
		Role:  "assistant",
		Model: resp.Model,
		Usage: UsageFromUnified(resp.Usage),
	}
	if out.ID == "" {
		out.ID = newID("msg")
	}

	if len(resp.Choices) == 0 {
		out.StopReason = "end_turn"
		return out
	}
	choice := resp.Choices[0]

	if rc := choice.Message.ReasoningContent; rc != "" {
		out.Content = append(out.Content, ContentBlock{
			Type:      "thinking",
			Thinking:  rc,
			Signature: choice.Message.ReasoningSignature,
		})
	}
	if text := choice.Message.Content.AsText(); text != "" {
		out.Content = append(out.Content, ContentBlock{Type: "text", Text: text})
	}
	for _, tc := range choice.Message.ToolCalls {
		out.Content = append(out.Content, toolCallToBlock(tc, names))
	}

	out.StopReason = FinishToStopReason(choice.FinishReason)
	if out.StopReason == "" {
		out.StopReason = "end_turn"
	}
	return out
}

// toolCallToBlock converts one unified tool call into a tool_use block,
// restoring the original tool name when a sanitized→original map is given.
func toolCallToBlock(tc api.ToolCall, names map[string]string) ContentBlock {
	id := tc.ID
	if id == "" {
		id = newID("toolu")
	}
	name := tc.Function.Name
	if orig, ok := names[name]; ok {
		name = orig
	}
	return ContentBlock{
		Type:  "tool_use",
		ID:    id,
		Name:  name,
		Input: argumentsToInput(tc.Function.Arguments),
	}
}

// argumentsToInput renders an OpenAI arguments string as a JSON object.
// tool_use.input must be an object; malformed or non-object arguments are
// preserved under a wrapper key instead of being discarded.
func argumentsToInput(args string) json.RawMessage {
	trimmed := strings.TrimSpace(args)
	if trimmed == "" {
		return json.RawMessage("{}")
	}
	if json.Valid([]byte(trimmed)) && strings.HasPrefix(trimmed, "{") {
		return json.RawMessage(trimmed)
	}
	wrapped, _ := json.Marshal(map[string]string{"_raw_arguments": args})
	return wrapped
}

// ── outbound: unified request → Anthropic request ───────────────────────────

// RequestFromUnified converts a unified request into the Messages API wire
// format for Anthropic backends. System/developer messages hoist into the
// system prompt; tool-role messages become tool_result blocks; consecutive
// same-role turns merge (the Messages API requires alternation).
func RequestFromUnified(req *api.ChatRequest) (*MessagesRequest, error) {
	out := &MessagesRequest{
		Model:       req.Model,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stream:      req.Stream,
	}

	switch {
	case req.MaxCompletionTokens != nil:
		out.MaxTokens = *req.MaxCompletionTokens
	case req.MaxTokens != nil:
		out.MaxTokens = *req.MaxTokens
	default:
		out.MaxTokens = DefaultMaxTokens
	}
	out.StopSequences = req.Stop
	if req.User != "" {
		out.Metadata = &Metadata{UserID: req.User}
	}
	if req.Extra != nil {
		if tk, ok := req.Extra["top_k"]; ok {
			if f, ok := toInt(tk); ok {
				out.TopK = &f
			}
		}
	}

	var systemParts []string
	for _, m := range req.Messages {
		switch m.Role {
		case "system", "developer":
			systemParts = append(systemParts, m.Content.AsText())
			continue
		}
		blocks, role, err := unifiedMessageToBlocks(m)
		if err != nil {
			return nil, err
		}
		if len(blocks) == 0 {
			continue
		}
		// Merge into the previous turn when the role repeats.
		if n := len(out.Messages); n > 0 && out.Messages[n-1].Role == role {
			merged := append(out.Messages[n-1].Content.AsBlocks(), blocks...)
			out.Messages[n-1].Content = BlocksContent(merged...)
		} else {
			out.Messages = append(out.Messages, InputMessage{
				Role:    role,
				Content: BlocksContent(blocks...),
			})
		}
	}
	if len(systemParts) > 0 {
		out.System = SystemPrompt{Text: strings.Join(systemParts, "\n\n")}
	}

	for _, t := range req.Tools {
		schema := t.Function.Parameters
		if len(schema) == 0 {
			// input_schema is required; an empty object schema is the
			// canonical "no arguments".
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out.Tools = append(out.Tools, Tool{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: schema,
		})
	}

	if tc := req.ToolChoice; tc != nil {
		switch tc.Mode {
		case "auto":
			out.ToolChoice = &ToolChoice{Type: "auto"}
		case "required":
			out.ToolChoice = &ToolChoice{Type: "any"}
		case "none":
			out.ToolChoice = &ToolChoice{Type: "none"}
		case "function":
			out.ToolChoice = &ToolChoice{Type: "tool", Name: tc.FunctionName}
		}
	}
	if req.ParallelToolCalls != nil && !*req.ParallelToolCalls && out.ToolChoice != nil {
		disable := true
		out.ToolChoice.DisableParallelToolUse = &disable
	}

	if req.ReasoningEffort != "" {
		budget := BudgetFromEffort(req.ReasoningEffort)
		out.Thinking = &Thinking{Type: "enabled", BudgetTokens: budget}
		// Thinking requires unset temperature/top_p and a max_tokens larger
		// than the budget.
		out.Temperature = nil
		out.TopP = nil
		if out.MaxTokens <= budget {
			out.MaxTokens = budget + DefaultMaxTokens
		}
	}

	return out, nil
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0, false
		}
		return int(i), true
	default:
		return 0, false
	}
}

// unifiedMessageToBlocks converts one unified message into Anthropic blocks
// plus the Anthropic role it belongs to.
func unifiedMessageToBlocks(m api.Message) ([]ContentBlock, string, error) {
	switch m.Role {
	case "tool":
		return []ContentBlock{{
			Type:      "tool_result",
			ToolUseID: m.ToolCallID,
			Content:   TextToolResult(m.Content.AsText()),
		}}, "user", nil

	case "assistant":
		var blocks []ContentBlock
		if m.ReasoningContent != "" {
			// The signature must round-trip: Anthropic rejects multi-turn
			// thinking history whose signatures were stripped.
			blocks = append(blocks, ContentBlock{
				Type:      "thinking",
				Thinking:  m.ReasoningContent,
				Signature: m.ReasoningSignature,
			})
		}
		if text := m.Content.AsText(); text != "" {
			blocks = append(blocks, ContentBlock{Type: "text", Text: text})
		}
		for _, tc := range m.ToolCalls {
			blocks = append(blocks, toolCallToBlock(tc, nil))
		}
		return blocks, "assistant", nil

	case "user":
		var blocks []ContentBlock
		if m.Content.Parts == nil {
			if text := m.Content.AsText(); text != "" || len(blocks) == 0 {
				blocks = append(blocks, ContentBlock{Type: "text", Text: text})
			}
			return blocks, "user", nil
		}
		for _, p := range m.Content.Parts {
			switch p.Type {
			case "text":
				blocks = append(blocks, ContentBlock{Type: "text", Text: p.Text})
			case "image_url":
				if p.ImageURL == nil {
					continue
				}
				src, err := imageURLToSource(p.ImageURL.URL)
				if err != nil {
					return nil, "", err
				}
				blocks = append(blocks, ContentBlock{Type: "image", Source: src})
			}
		}
		return blocks, "user", nil

	default:
		return nil, "", fmt.Errorf("unsupported message role %q", m.Role)
	}
}

// imageURLToSource converts an OpenAI image_url (https URL or data: URI) into
// an Anthropic image source.
func imageURLToSource(url string) (*Source, error) {
	if strings.HasPrefix(url, "data:") {
		rest := strings.TrimPrefix(url, "data:")
		semi := strings.Index(rest, ";base64,")
		if semi < 0 {
			return nil, fmt.Errorf("unsupported data URI (expected ;base64,)")
		}
		return &Source{
			Type:      "base64",
			MediaType: rest[:semi],
			Data:      rest[semi+len(";base64,"):],
		}, nil
	}
	return &Source{Type: "url", URL: url}, nil
}

// ── outbound: Anthropic response → unified ──────────────────────────────────

// ResponseToUnified converts a Messages API response into a unified response.
func ResponseToUnified(mresp *MessagesResponse) *api.ChatResponse {
	msg := api.Message{Role: "assistant"}
	var text strings.Builder
	var reasoning strings.Builder
	for _, b := range mresp.Content {
		switch b.Type {
		case "text":
			text.WriteString(b.Text)
		case "thinking":
			reasoning.WriteString(b.Thinking)
			if b.Signature != "" {
				msg.ReasoningSignature = b.Signature
			}
		case "tool_use":
			args := "{}"
			if len(b.Input) > 0 {
				args = string(b.Input)
			}
			msg.ToolCalls = append(msg.ToolCalls, api.ToolCall{
				ID:   b.ID,
				Type: "function",
				Function: api.ToolCallFunction{
					Name:      b.Name,
					Arguments: args,
				},
			})
		}
	}
	if text.Len() > 0 {
		msg.Content = api.TextContent(text.String())
	}
	msg.ReasoningContent = reasoning.String()

	return &api.ChatResponse{
		ID:     mresp.ID,
		Object: "chat.completion",
		Model:  mresp.Model,
		Choices: []api.Choice{{
			Index:        0,
			Message:      msg,
			FinishReason: StopReasonToFinish(mresp.StopReason),
		}},
		Usage: UsageToUnified(mresp.Usage),
	}
}
