package anthropic

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

// A request in the shape Claude Code sends: system array with cache_control,
// tool declarations, and a history containing an assistant tool_use turn and
// a user turn packing tool_result blocks.
const claudeCodeRequest = `{
  "model": "claude-sonnet-4-5",
  "max_tokens": 8192,
  "system": [
    {"type": "text", "text": "You are Claude Code.", "cache_control": {"type": "ephemeral"}}
  ],
  "metadata": {"user_id": "session-abc"},
  "temperature": 1,
  "stream": true,
  "tools": [
    {"name": "Bash", "description": "Run a command", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
    {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}
  ],
  "messages": [
    {"role": "user", "content": "list the files"},
    {"role": "assistant", "content": [
      {"type": "text", "text": "I'll list them."},
      {"type": "tool_use", "id": "toolu_01", "name": "Bash", "input": {"command": "ls"}}
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "toolu_01", "content": "a.txt\nb.txt"},
      {"type": "text", "text": "now delete them"}
    ]}
  ]
}`

func TestRequestToUnifiedClaudeCodeShape(t *testing.T) {
	var mreq MessagesRequest
	if err := json.Unmarshal([]byte(claudeCodeRequest), &mreq); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	req, err := RequestToUnified(&mreq)
	if err != nil {
		t.Fatalf("RequestToUnified: %v", err)
	}

	if req.Model != "claude-sonnet-4-5" {
		t.Errorf("model = %q", req.Model)
	}
	if req.MaxTokens == nil || *req.MaxTokens != 8192 {
		t.Errorf("max_tokens = %v", req.MaxTokens)
	}
	if !req.Stream {
		t.Error("stream not carried")
	}
	if req.User != "session-abc" {
		t.Errorf("user = %q", req.User)
	}

	// Only the client tool translates; the server tool is dropped.
	if len(req.Tools) != 1 || req.Tools[0].Function.Name != "Bash" {
		t.Fatalf("tools = %+v", req.Tools)
	}

	// system, user, assistant(+tool_calls), tool, user — in that order.
	roles := make([]string, len(req.Messages))
	for i, m := range req.Messages {
		roles[i] = m.Role
	}
	want := []string{"system", "user", "assistant", "tool", "user"}
	if strings.Join(roles, ",") != strings.Join(want, ",") {
		t.Fatalf("roles = %v, want %v", roles, want)
	}

	asst := req.Messages[2]
	if len(asst.ToolCalls) != 1 || asst.ToolCalls[0].ID != "toolu_01" {
		t.Fatalf("assistant tool calls = %+v", asst.ToolCalls)
	}
	if asst.ToolCalls[0].Function.Name != "Bash" {
		t.Errorf("tool name = %q", asst.ToolCalls[0].Function.Name)
	}
	var args map[string]string
	if err := json.Unmarshal([]byte(asst.ToolCalls[0].Function.Arguments), &args); err != nil {
		t.Fatalf("arguments not JSON: %v", err)
	}
	if args["command"] != "ls" {
		t.Errorf("arguments = %v", args)
	}

	toolMsg := req.Messages[3]
	if toolMsg.ToolCallID != "toolu_01" {
		t.Errorf("tool_call_id = %q", toolMsg.ToolCallID)
	}
	if got := toolMsg.Content.AsText(); got != "a.txt\nb.txt" {
		t.Errorf("tool result = %q", got)
	}

	if got := req.Messages[4].Content.AsText(); got != "now delete them" {
		t.Errorf("trailing user text = %q", got)
	}
}

// Claude Code injects system-role messages into the messages array (context
// reminders), beyond the top-level system field. They must translate to
// unified system messages, not fail the request.
func TestRequestToUnifiedSystemRoleMessage(t *testing.T) {
	raw := `{"model":"claude-sonnet-4-5","max_tokens":1,"messages":[
		{"role":"user","content":"hi"},
		{"role":"system","content":[{"type":"text","text":"reminder: be brief"}]},
		{"role":"user","content":"go on"}]}`
	var mreq MessagesRequest
	if err := json.Unmarshal([]byte(raw), &mreq); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	req, err := RequestToUnified(&mreq)
	if err != nil {
		t.Fatalf("RequestToUnified: %v", err)
	}
	roles := make([]string, len(req.Messages))
	for i, m := range req.Messages {
		roles[i] = m.Role
	}
	if strings.Join(roles, ",") != "user,system,user" {
		t.Fatalf("roles = %v, want [user system user]", roles)
	}
	if got := req.Messages[1].Content.AsText(); got != "reminder: be brief" {
		t.Errorf("system message text = %q", got)
	}
}

func TestRequestToUnifiedToleratesUnknownFields(t *testing.T) {
	raw := `{"model":"claude-3-5-haiku-20241022","max_tokens":1,"messages":[{"role":"user","content":"hi"}],"some_future_field":{"x":1},"betas":["b1"]}`
	var mreq MessagesRequest
	if err := json.Unmarshal([]byte(raw), &mreq); err != nil {
		t.Fatalf("unknown fields must not fail decoding: %v", err)
	}
	if _, err := RequestToUnified(&mreq); err != nil {
		t.Fatalf("RequestToUnified: %v", err)
	}
}

func TestRequestRoundTrip(t *testing.T) {
	// unified → anthropic → unified preserves the conversation structure.
	orig := &api.ChatRequest{
		Model: "claude-sonnet-4-5",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be terse")},
			{Role: "user", Content: api.TextContent("hello")},
			{Role: "assistant", ToolCalls: []api.ToolCall{{
				ID: "call_1", Type: "function",
				Function: api.ToolCallFunction{Name: "f", Arguments: `{"a":1}`},
			}}},
			{Role: "tool", ToolCallID: "call_1", Content: api.TextContent("42")},
			{Role: "user", Content: api.TextContent("thanks")},
		},
		Tools: []api.Tool{{Type: "function", Function: api.ToolFunction{
			Name: "f", Parameters: json.RawMessage(`{"type":"object"}`),
		}}},
	}

	mreq, err := RequestFromUnified(orig)
	if err != nil {
		t.Fatalf("RequestFromUnified: %v", err)
	}
	if mreq.System.JoinedText() != "be terse" {
		t.Errorf("system = %q", mreq.System.JoinedText())
	}
	if mreq.MaxTokens != DefaultMaxTokens {
		t.Errorf("max_tokens default = %d", mreq.MaxTokens)
	}
	// The tool message and the following user text merge into one user turn
	// (Messages API alternation): user / assistant / user[tool_result, text].
	if len(mreq.Messages) != 3 {
		t.Fatalf("anthropic messages = %d, want 3 (%+v)", len(mreq.Messages), mreq.Messages)
	}
	last := mreq.Messages[2]
	if last.Role != "user" {
		t.Errorf("last role = %q", last.Role)
	}
	lastBlocks := last.Content.AsBlocks()
	if len(lastBlocks) != 2 || lastBlocks[0].Type != "tool_result" || lastBlocks[1].Type != "text" {
		t.Fatalf("merged user blocks = %+v", lastBlocks)
	}

	back, err := RequestToUnified(mreq)
	if err != nil {
		t.Fatalf("RequestToUnified: %v", err)
	}
	roles := make([]string, len(back.Messages))
	for i, m := range back.Messages {
		roles[i] = m.Role
	}
	want := []string{"system", "user", "assistant", "tool", "user"}
	if strings.Join(roles, ",") != strings.Join(want, ",") {
		t.Fatalf("round-trip roles = %v, want %v", roles, want)
	}
}

func TestResponseFromUnifiedToolCalls(t *testing.T) {
	resp := &api.ChatResponse{
		ID:    "chatcmpl-1",
		Model: "gpt-4o",
		Choices: []api.Choice{{
			Message: api.Message{
				Role:    "assistant",
				Content: api.TextContent("Running it."),
				ToolCalls: []api.ToolCall{{
					ID: "call_9", Type: "function",
					Function: api.ToolCallFunction{Name: "Bash", Arguments: `{"command":"ls"}`},
				}},
			},
			FinishReason: "tool_calls",
		}},
		Usage: &api.Usage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15},
	}

	mresp := ResponseFromUnified(resp)
	if mresp.StopReason != "tool_use" {
		t.Errorf("stop_reason = %q", mresp.StopReason)
	}
	if len(mresp.Content) != 2 {
		t.Fatalf("content blocks = %+v", mresp.Content)
	}
	if mresp.Content[0].Type != "text" || mresp.Content[0].Text != "Running it." {
		t.Errorf("text block = %+v", mresp.Content[0])
	}
	tu := mresp.Content[1]
	if tu.Type != "tool_use" || tu.ID != "call_9" || tu.Name != "Bash" {
		t.Errorf("tool_use block = %+v", tu)
	}
	if string(tu.Input) != `{"command":"ls"}` {
		t.Errorf("input = %s", tu.Input)
	}
	if mresp.Usage.InputTokens != 10 || mresp.Usage.OutputTokens != 5 {
		t.Errorf("usage = %+v", mresp.Usage)
	}
}

func TestArgumentsToInputMalformed(t *testing.T) {
	for _, tc := range []struct{ in, wantKey string }{
		{"", ""},                    // empty → {}
		{`{"a":1}`, ""},             // valid object passes through
		{`[1,2]`, "_raw_arguments"}, // non-object wrapped
		{`{"a":`, "_raw_arguments"}, // truncated wrapped
		{`not json`, "_raw_arguments"},
	} {
		out := argumentsToInput(tc.in)
		var m map[string]any
		if err := json.Unmarshal(out, &m); err != nil {
			t.Fatalf("argumentsToInput(%q) not an object: %s", tc.in, out)
		}
		if tc.wantKey != "" {
			if _, ok := m[tc.wantKey]; !ok {
				t.Errorf("argumentsToInput(%q) = %s, want wrapper key %q", tc.in, out, tc.wantKey)
			}
		}
	}
}

func TestUsageConversionsRoundTrip(t *testing.T) {
	anth := &Usage{
		InputTokens:              100,
		OutputTokens:             50,
		CacheReadInputTokens:     1000,
		CacheCreationInputTokens: 200,
	}
	uni := UsageToUnified(anth)
	if uni.PromptTokens != 1300 {
		t.Errorf("prompt tokens = %d, want 1300 (input+cache)", uni.PromptTokens)
	}
	if uni.PromptTokensDetails.CachedTokens != 1000 {
		t.Errorf("cached = %d", uni.PromptTokensDetails.CachedTokens)
	}
	back := UsageFromUnified(uni)
	if back.InputTokens != 100 || back.CacheReadInputTokens != 1000 || back.CacheCreationInputTokens != 200 {
		t.Errorf("round trip = %+v", back)
	}
}

func TestThinkingMapsToReasoningEffortAndBack(t *testing.T) {
	mreq := &MessagesRequest{
		Model:     "claude-sonnet-4-5",
		MaxTokens: 1024,
		Thinking:  &Thinking{Type: "enabled", BudgetTokens: 20000},
		Messages:  []InputMessage{{Role: "user", Content: TextBlockContent("hi")}},
	}
	req, err := RequestToUnified(mreq)
	if err != nil {
		t.Fatal(err)
	}
	if req.ReasoningEffort != "high" {
		t.Errorf("effort = %q, want high", req.ReasoningEffort)
	}

	back, err := RequestFromUnified(req)
	if err != nil {
		t.Fatal(err)
	}
	if back.Thinking == nil || back.Thinking.Type != "enabled" {
		t.Fatalf("thinking = %+v", back.Thinking)
	}
	if back.Temperature != nil {
		t.Error("temperature must be unset when thinking is enabled")
	}
	if back.MaxTokens <= back.Thinking.BudgetTokens {
		t.Errorf("max_tokens %d must exceed budget %d", back.MaxTokens, back.Thinking.BudgetTokens)
	}
}

// TestThinkingSignatureRoundTrip: Anthropic backends reject multi-turn
// thinking history whose signatures were stripped, so the signature must
// survive anthropic → unified → anthropic.
func TestThinkingSignatureRoundTrip(t *testing.T) {
	mreq := &MessagesRequest{
		Model: "claude-sonnet-4-5", MaxTokens: 10,
		Messages: []InputMessage{
			{Role: "user", Content: TextBlockContent("hi")},
			{Role: "assistant", Content: BlocksContent(
				ContentBlock{Type: "thinking", Thinking: "let me think", Signature: "sig_abc"},
				ContentBlock{Type: "text", Text: "answer"},
			)},
		},
	}
	req, err := RequestToUnified(mreq)
	if err != nil {
		t.Fatal(err)
	}
	asst := req.Messages[1]
	if asst.ReasoningContent != "let me think" || asst.ReasoningSignature != "sig_abc" {
		t.Fatalf("assistant reasoning = %q sig = %q", asst.ReasoningContent, asst.ReasoningSignature)
	}

	back, err := RequestFromUnified(req)
	if err != nil {
		t.Fatal(err)
	}
	blocks := back.Messages[1].Content.AsBlocks()
	if len(blocks) == 0 || blocks[0].Type != "thinking" {
		t.Fatalf("assistant blocks = %+v", blocks)
	}
	if blocks[0].Signature != "sig_abc" {
		t.Errorf("signature = %q, want sig_abc", blocks[0].Signature)
	}
}

func TestResponseToUnifiedCapturesThinkingSignature(t *testing.T) {
	mresp := &MessagesResponse{
		ID: "msg_1", Model: "claude-sonnet-4-5", StopReason: "end_turn",
		Content: []ContentBlock{
			{Type: "thinking", Thinking: "hmm", Signature: "sig_xyz"},
			{Type: "text", Text: "hi"},
		},
	}
	uni := ResponseToUnified(mresp)
	if got := uni.Choices[0].Message.ReasoningSignature; got != "sig_xyz" {
		t.Errorf("ReasoningSignature = %q, want sig_xyz", got)
	}
}

// TestToolResultImageBecomesUserImagePart: OpenAI tool-role messages carry
// only text, so a tool_result's nested image must ride on a following user
// message rather than being dropped.
func TestToolResultImageBecomesUserImagePart(t *testing.T) {
	mreq := &MessagesRequest{
		Model: "claude-sonnet-4-5", MaxTokens: 10,
		Messages: []InputMessage{{Role: "user", Content: BlocksContent(
			ContentBlock{
				Type: "tool_result", ToolUseID: "toolu_1",
				Content: &ToolResultValue{Blocks: []ContentBlock{
					{Type: "image", Source: &Source{Type: "base64", MediaType: "image/png", Data: "AAAA"}},
				}},
			},
		)}},
	}
	req, err := RequestToUnified(mreq)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %+v, want tool + user", req.Messages)
	}
	if req.Messages[0].Role != "tool" || req.Messages[0].ToolCallID != "toolu_1" {
		t.Fatalf("tool message = %+v", req.Messages[0])
	}
	user := req.Messages[1]
	if user.Role != "user" {
		t.Fatalf("second message role = %q, want user", user.Role)
	}
	parts := user.Content.Parts
	if len(parts) != 1 || parts[0].Type != "image_url" {
		t.Fatalf("user parts = %+v, want one image_url", parts)
	}
	if parts[0].ImageURL.URL != "data:image/png;base64,AAAA" {
		t.Errorf("image url = %q", parts[0].ImageURL.URL)
	}
}

// TestToolNameSanitizedAndRestored: OpenAI rejects function names longer than
// 64 chars; long MCP names must be sanitized on the way in and restored on
// the way back out.
func TestToolNameSanitizedAndRestored(t *testing.T) {
	long := "mcp__myserver__" + strings.Repeat("a", 55) // 70 chars
	sibling := "mcp__myserver__" + strings.Repeat("a", 54) + "b"
	mreq := &MessagesRequest{
		Model: "claude-sonnet-4-5", MaxTokens: 10,
		Tools: []Tool{
			{Name: long, InputSchema: json.RawMessage(`{"type":"object"}`)},
			{Name: sibling, InputSchema: json.RawMessage(`{"type":"object"}`)},
		},
		Messages: []InputMessage{
			{Role: "user", Content: TextBlockContent("hi")},
			{Role: "assistant", Content: BlocksContent(
				ContentBlock{Type: "tool_use", ID: "toolu_1", Name: long, Input: json.RawMessage(`{}`)},
			)},
			{Role: "user", Content: BlocksContent(
				ContentBlock{Type: "tool_result", ToolUseID: "toolu_1", Content: TextToolResult("ok")},
			)},
		},
	}
	req, names, err := RequestToUnifiedWithTools(mreq)
	if err != nil {
		t.Fatal(err)
	}

	sanitized := req.Tools[0].Function.Name
	if len(sanitized) > 64 {
		t.Errorf("sanitized name %q is %d chars, want <= 64", sanitized, len(sanitized))
	}
	for i := 0; i < len(sanitized); i++ {
		c := sanitized[i]
		valid := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-'
		if !valid {
			t.Errorf("sanitized name %q has invalid char %q", sanitized, c)
		}
	}
	if names[sanitized] != long {
		t.Errorf("names[%q] = %q, want %q", sanitized, names[sanitized], long)
	}
	// Distinct long names must stay distinct after truncation.
	if req.Tools[1].Function.Name == sanitized {
		t.Errorf("sibling name collided: %q", sanitized)
	}
	// History tool_use must reference the same sanitized name as the tools.
	if got := req.Messages[1].ToolCalls[0].Function.Name; got != sanitized {
		t.Errorf("history tool call name = %q, want %q", got, sanitized)
	}

	// The response path restores the original name.
	resp := &api.ChatResponse{
		ID: "chatcmpl-1", Model: "gpt-4o",
		Choices: []api.Choice{{
			Message: api.Message{
				Role: "assistant",
				ToolCalls: []api.ToolCall{{
					ID: "call_1", Type: "function",
					Function: api.ToolCallFunction{Name: sanitized, Arguments: `{}`},
				}},
			},
			FinishReason: "tool_calls",
		}},
	}
	mresp := ResponseFromUnifiedNamed(resp, names)
	if got := mresp.Content[0].Name; got != long {
		t.Errorf("restored tool_use name = %q, want %q", got, long)
	}
}

func TestSanitizeToolNamePassesValidNames(t *testing.T) {
	for _, name := range []string{"Bash", "mcp__srv__tool", strings.Repeat("x", 64)} {
		if got := sanitizeToolName(name); got != name {
			t.Errorf("sanitizeToolName(%q) = %q, want unchanged", name, got)
		}
	}
}

// TestDocumentBlockNeverSilentlyDropped: a document block with no title still
// leaves a trace in the turn.
func TestDocumentBlockNeverSilentlyDropped(t *testing.T) {
	mreq := &MessagesRequest{
		Model: "claude-sonnet-4-5", MaxTokens: 10,
		Messages: []InputMessage{{Role: "user", Content: BlocksContent(
			ContentBlock{Type: "document", Source: &Source{Type: "base64", MediaType: "application/pdf", Data: "AAAA"}},
		)}},
	}
	req, err := RequestToUnified(mreq)
	if err != nil {
		t.Fatal(err)
	}
	if got := req.Messages[0].Content.AsText(); got != "[document]" {
		t.Errorf("untitled document text = %q, want [document]", got)
	}

	mreq.Messages[0].Content = BlocksContent(
		ContentBlock{Type: "document", Title: "Q3 report", Source: &Source{Type: "base64", MediaType: "application/pdf", Data: "AAAA"}},
	)
	req, err = RequestToUnified(mreq)
	if err != nil {
		t.Fatal(err)
	}
	if got := req.Messages[0].Content.AsText(); got != "[document: Q3 report]" {
		t.Errorf("titled document text = %q", got)
	}
}

func TestImageTranslation(t *testing.T) {
	mreq := &MessagesRequest{
		Model: "claude-sonnet-4-5", MaxTokens: 10,
		Messages: []InputMessage{{Role: "user", Content: BlocksContent(
			ContentBlock{Type: "text", Text: "what is this"},
			ContentBlock{Type: "image", Source: &Source{Type: "base64", MediaType: "image/png", Data: "AAAA"}},
		)}},
	}
	req, err := RequestToUnified(mreq)
	if err != nil {
		t.Fatal(err)
	}
	parts := req.Messages[0].Content.Parts
	if len(parts) != 2 || parts[1].Type != "image_url" {
		t.Fatalf("parts = %+v", parts)
	}
	if parts[1].ImageURL.URL != "data:image/png;base64,AAAA" {
		t.Errorf("data uri = %q", parts[1].ImageURL.URL)
	}

	// And back out to Anthropic form.
	back, err := RequestFromUnified(req)
	if err != nil {
		t.Fatal(err)
	}
	blocks := back.Messages[0].Content.AsBlocks()
	if len(blocks) != 2 || blocks[1].Type != "image" {
		t.Fatalf("blocks = %+v", blocks)
	}
	if blocks[1].Source.MediaType != "image/png" || blocks[1].Source.Data != "AAAA" {
		t.Errorf("source = %+v", blocks[1].Source)
	}
}
