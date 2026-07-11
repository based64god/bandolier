package gemini

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

// ── wire types (generateContent REST v1beta) ────────────────────────────────

type genRequest struct {
	Contents          []content         `json:"contents"`
	SystemInstruction *content          `json:"systemInstruction,omitempty"`
	Tools             []toolBlock       `json:"tools,omitempty"`
	ToolConfig        *toolConfig       `json:"toolConfig,omitempty"`
	GenerationConfig  *generationConfig `json:"generationConfig,omitempty"`
}

// content is one conversation turn: role "user" or "model" (absent on
// systemInstruction).
type content struct {
	Role  string `json:"role,omitempty"`
	Parts []part `json:"parts"`
}

// part is Gemini's content unit; exactly one payload field is set. Thought
// marks reasoning output and only appears on responses.
type part struct {
	Text             string            `json:"text,omitempty"`
	Thought          bool              `json:"thought,omitempty"`
	InlineData       *inlineData       `json:"inlineData,omitempty"`
	FileData         *fileData         `json:"fileData,omitempty"`
	FunctionCall     *functionCall     `json:"functionCall,omitempty"`
	FunctionResponse *functionResponse `json:"functionResponse,omitempty"`
}

type inlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type fileData struct {
	MimeType string `json:"mimeType,omitempty"`
	FileURI  string `json:"fileUri"`
}

// functionCall args are a JSON object, unlike the unified format's string.
type functionCall struct {
	Name string          `json:"name"`
	Args json.RawMessage `json:"args,omitempty"`
}

type functionResponse struct {
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

type toolBlock struct {
	FunctionDeclarations []functionDeclaration `json:"functionDeclarations"`
}

type functionDeclaration struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

type toolConfig struct {
	FunctionCallingConfig functionCallingConfig `json:"functionCallingConfig"`
}

type functionCallingConfig struct {
	Mode                 string   `json:"mode"` // AUTO | NONE | ANY
	AllowedFunctionNames []string `json:"allowedFunctionNames,omitempty"`
}

type generationConfig struct {
	Temperature      *float64        `json:"temperature,omitempty"`
	TopP             *float64        `json:"topP,omitempty"`
	TopK             *int            `json:"topK,omitempty"`
	MaxOutputTokens  *int            `json:"maxOutputTokens,omitempty"`
	StopSequences    []string        `json:"stopSequences,omitempty"`
	CandidateCount   *int            `json:"candidateCount,omitempty"`
	ResponseMimeType string          `json:"responseMimeType,omitempty"`
	ResponseSchema   json.RawMessage `json:"responseSchema,omitempty"`
	ThinkingConfig   *thinkingConfig `json:"thinkingConfig,omitempty"`
}

type thinkingConfig struct {
	ThinkingBudget  int  `json:"thinkingBudget"`
	IncludeThoughts bool `json:"includeThoughts,omitempty"`
}

type genResponse struct {
	Candidates     []candidate     `json:"candidates"`
	PromptFeedback *promptFeedback `json:"promptFeedback"`
	UsageMetadata  *usageMetadata  `json:"usageMetadata"`
	ModelVersion   string          `json:"modelVersion"`
	ResponseID     string          `json:"responseId"`
}

type candidate struct {
	Content      *content `json:"content"`
	FinishReason string   `json:"finishReason"`
	Index        *int     `json:"index"`
}

type promptFeedback struct {
	BlockReason string `json:"blockReason"`
}

type usageMetadata struct {
	PromptTokenCount        int `json:"promptTokenCount"`
	CandidatesTokenCount    int `json:"candidatesTokenCount"`
	TotalTokenCount         int `json:"totalTokenCount"`
	CachedContentTokenCount int `json:"cachedContentTokenCount"`
	ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
}

// ── embedContent wire types ─────────────────────────────────────────────────

type embedContentRequest struct {
	// Model is required per-entry on :batchEmbedContents, path-only otherwise.
	Model                string  `json:"model,omitempty"`
	Content              content `json:"content"`
	OutputDimensionality *int    `json:"outputDimensionality,omitempty"`
}

type batchEmbedRequest struct {
	Requests []embedContentRequest `json:"requests"`
}

type embedValues struct {
	Values []float64 `json:"values"`
}

type embedContentResponse struct {
	Embedding     *embedValues   `json:"embedding"`
	UsageMetadata *usageMetadata `json:"usageMetadata"`
}

type batchEmbedResponse struct {
	Embeddings    []embedValues  `json:"embeddings"`
	UsageMetadata *usageMetadata `json:"usageMetadata"`
}

// ── outbound: unified request → Gemini request ──────────────────────────────

// thinkingBudgets maps OpenAI reasoning_effort onto Gemini thinking budgets
// (litellm's defaults).
var thinkingBudgets = map[string]int{
	"minimal": 1024,
	"low":     1024,
	"medium":  8192,
	"high":    24576,
}

// requestToWire converts a unified request into generateContent form.
// System/developer messages hoist into systemInstruction; consecutive
// same-role turns merge (Gemini expects user/model alternation); unsupported
// parameters and content types drop silently (litellm's drop_params).
func requestToWire(req *api.ChatRequest) *genRequest {
	out := &genRequest{}

	// functionResponse needs the function *name*, but unified tool messages
	// carry only tool_call_id — recover names from prior assistant tool_calls.
	callNames := map[string]string{}
	for _, m := range req.Messages {
		if m.Role != "assistant" {
			continue
		}
		for _, tc := range m.ToolCalls {
			if tc.ID != "" && tc.Function.Name != "" {
				callNames[tc.ID] = tc.Function.Name
			}
		}
	}

	var sysParts []part
	for _, m := range req.Messages {
		switch m.Role {
		case "system", "developer":
			if t := m.Content.AsText(); t != "" {
				sysParts = append(sysParts, part{Text: t})
			}
		case "assistant":
			appendTurn(out, "model", assistantParts(m))
		case "tool":
			name := callNames[m.ToolCallID]
			if name == "" {
				name = m.Name
			}
			if name == "" {
				name = m.ToolCallID
			}
			appendTurn(out, "user", []part{{FunctionResponse: &functionResponse{
				Name:     name,
				Response: map[string]any{"content": m.Content.AsText()},
			}}})
		default: // "user" and any unrecognized role
			appendTurn(out, "user", userParts(m.Content))
		}
	}
	if len(sysParts) > 0 {
		out.SystemInstruction = &content{Parts: sysParts}
	}

	if len(req.Tools) > 0 {
		decls := make([]functionDeclaration, 0, len(req.Tools))
		for _, t := range req.Tools {
			decls = append(decls, functionDeclaration{
				Name:        t.Function.Name,
				Description: t.Function.Description,
				Parameters:  sanitizeSchema(t.Function.Parameters),
			})
		}
		out.Tools = []toolBlock{{FunctionDeclarations: decls}}
	}

	if req.ToolChoice != nil {
		switch req.ToolChoice.Mode {
		case "auto":
			out.ToolConfig = &toolConfig{functionCallingConfig{Mode: "AUTO"}}
		case "none":
			out.ToolConfig = &toolConfig{functionCallingConfig{Mode: "NONE"}}
		case "required":
			out.ToolConfig = &toolConfig{functionCallingConfig{Mode: "ANY"}}
		case "function":
			out.ToolConfig = &toolConfig{functionCallingConfig{
				Mode:                 "ANY",
				AllowedFunctionNames: []string{req.ToolChoice.FunctionName},
			}}
		}
	}

	gc := &generationConfig{
		Temperature:    req.Temperature,
		TopP:           req.TopP,
		StopSequences:  req.Stop,
		CandidateCount: req.N,
	}
	if tk, ok := req.Extra["top_k"]; ok {
		if n, ok := toInt(tk); ok {
			gc.TopK = &n
		}
	}
	switch {
	case req.MaxCompletionTokens != nil:
		gc.MaxOutputTokens = req.MaxCompletionTokens
	case req.MaxTokens != nil:
		gc.MaxOutputTokens = req.MaxTokens
	}
	if rf := req.ResponseFormat; rf != nil {
		switch rf.Type {
		case "json_object":
			gc.ResponseMimeType = "application/json"
		case "json_schema":
			gc.ResponseMimeType = "application/json"
			if rf.JSONSchema != nil {
				gc.ResponseSchema = sanitizeSchema(rf.JSONSchema.Schema)
			}
		}
	}
	if budget, ok := thinkingBudgets[req.ReasoningEffort]; ok {
		gc.ThinkingConfig = &thinkingConfig{ThinkingBudget: budget, IncludeThoughts: true}
	}
	if gc.Temperature != nil || gc.TopP != nil || gc.TopK != nil || gc.MaxOutputTokens != nil ||
		len(gc.StopSequences) > 0 || gc.CandidateCount != nil || gc.ResponseMimeType != "" ||
		gc.ResponseSchema != nil || gc.ThinkingConfig != nil {
		out.GenerationConfig = gc
	}
	return out
}

// appendTurn adds parts as a new turn, merging into the previous one when the
// role repeats. Empty turns are dropped (Gemini rejects empty parts arrays).
func appendTurn(out *genRequest, role string, parts []part) {
	if len(parts) == 0 {
		return
	}
	if n := len(out.Contents); n > 0 && out.Contents[n-1].Role == role {
		out.Contents[n-1].Parts = append(out.Contents[n-1].Parts, parts...)
		return
	}
	out.Contents = append(out.Contents, content{Role: role, Parts: parts})
}

// userParts converts unified user content. Data-URI images become inlineData;
// http(s) URLs become fileData references.
func userParts(mc api.MessageContent) []part {
	if mc.Parts == nil {
		if mc.Text == "" {
			return nil
		}
		return []part{{Text: mc.Text}}
	}
	var parts []part
	for _, cp := range mc.Parts {
		switch cp.Type {
		case "text":
			if cp.Text != "" {
				parts = append(parts, part{Text: cp.Text})
			}
		case "image_url":
			if cp.ImageURL == nil {
				continue
			}
			if mime, data, ok := parseDataURI(cp.ImageURL.URL); ok {
				parts = append(parts, part{InlineData: &inlineData{MimeType: mime, Data: data}})
			} else {
				parts = append(parts, part{FileData: &fileData{FileURI: cp.ImageURL.URL}})
			}
		}
	}
	return parts
}

func assistantParts(m api.Message) []part {
	var parts []part
	if t := m.Content.AsText(); t != "" {
		parts = append(parts, part{Text: t})
	}
	for _, tc := range m.ToolCalls {
		parts = append(parts, part{FunctionCall: &functionCall{
			Name: tc.Function.Name,
			Args: toolArgs(tc.Function.Arguments),
		}})
	}
	return parts
}

// toolArgs decodes the unified JSON-string arguments into the object Gemini
// expects; malformed args are preserved under a sentinel key rather than lost
// (same decision as the anthropic wire package).
func toolArgs(args string) json.RawMessage {
	trimmed := strings.TrimSpace(args)
	if trimmed == "" {
		return json.RawMessage("{}")
	}
	if json.Valid([]byte(trimmed)) {
		return json.RawMessage(trimmed)
	}
	wrapped, _ := json.Marshal(map[string]string{"_raw_arguments": args})
	return wrapped
}

// parseDataURI splits "data:<mime>;base64,<data>"; ok is false for any other
// form.
func parseDataURI(uri string) (mime, data string, ok bool) {
	rest, found := strings.CutPrefix(uri, "data:")
	if !found {
		return "", "", false
	}
	mime, data, found = strings.Cut(rest, ";base64,")
	if !found {
		return "", "", false
	}
	return mime, data, true
}

// sanitizeSchema strips the JSON Schema metadata keys Gemini rejects
// ($schema, $id, additionalProperties, strict) at every nesting level.
// Unparseable schemas pass through untouched — let the API report them.
func sanitizeSchema(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw
	}
	stripUnsupportedKeys(v)
	out, err := json.Marshal(v)
	if err != nil {
		return raw
	}
	return out
}

func stripUnsupportedKeys(v any) {
	switch t := v.(type) {
	case map[string]any:
		delete(t, "$schema")
		delete(t, "$id")
		delete(t, "additionalProperties")
		delete(t, "strict")
		for _, child := range t {
			stripUnsupportedKeys(child)
		}
	case []any:
		for _, child := range t {
			stripUnsupportedKeys(child)
		}
	}
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
		if i, err := n.Int64(); err == nil {
			return int(i), true
		}
	}
	return 0, false
}

// ── inbound: Gemini response → unified response ─────────────────────────────

// finishReasons maps Gemini finish reasons onto OpenAI's values; safety
// blocks of every flavor collapse into content_filter. Unknown reasons map
// to "stop", and any candidate carrying a functionCall reports tool_calls
// regardless (Gemini says STOP for those).
var finishReasons = map[string]string{
	"STOP":               "stop",
	"MAX_TOKENS":         "length",
	"SAFETY":             "content_filter",
	"RECITATION":         "content_filter",
	"BLOCKLIST":          "content_filter",
	"PROHIBITED_CONTENT": "content_filter",
	"SPII":               "content_filter",
	"IMAGE_SAFETY":       "content_filter",
}

func mapFinishReason(reason string, sawToolCall bool) string {
	if sawToolCall {
		return "tool_calls"
	}
	if mapped, ok := finishReasons[reason]; ok {
		return mapped
	}
	return "stop"
}

func responseToUnified(model string, gr *genResponse) *api.ChatResponse {
	resp := &api.ChatResponse{
		ID:      gr.ResponseID,
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   model,
	}
	if resp.ID == "" {
		resp.ID = fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano())
	}
	if gr.ModelVersion != "" {
		resp.Model = gr.ModelVersion
	}

	// A blocked prompt returns no candidates, only promptFeedback.
	if len(gr.Candidates) == 0 && gr.PromptFeedback != nil && gr.PromptFeedback.BlockReason != "" {
		resp.Choices = append(resp.Choices, api.Choice{
			Message:      api.Message{Role: "assistant"},
			FinishReason: "content_filter",
		})
	}

	callSeq := 0
	for i, cand := range gr.Candidates {
		idx := i
		if cand.Index != nil {
			idx = *cand.Index
		}
		msg := api.Message{Role: "assistant"}
		var text, reasoning strings.Builder
		sawTool := false
		if cand.Content != nil {
			for _, pt := range cand.Content.Parts {
				switch {
				case pt.FunctionCall != nil:
					callSeq++
					sawTool = true
					args := string(pt.FunctionCall.Args)
					if args == "" {
						args = "{}"
					}
					msg.ToolCalls = append(msg.ToolCalls, api.ToolCall{
						// Gemini has no call ids; synthesize them.
						ID:   fmt.Sprintf("call_%d", callSeq),
						Type: "function",
						Function: api.ToolCallFunction{
							Name:      pt.FunctionCall.Name,
							Arguments: args,
						},
					})
				case pt.Thought:
					reasoning.WriteString(pt.Text)
				default:
					text.WriteString(pt.Text)
				}
			}
		}
		msg.ReasoningContent = reasoning.String()
		// Tool-call-only messages keep null content (OpenAI convention).
		if text.Len() > 0 || !sawTool {
			msg.Content = api.TextContent(text.String())
		}
		resp.Choices = append(resp.Choices, api.Choice{
			Index:        idx,
			Message:      msg,
			FinishReason: mapFinishReason(cand.FinishReason, sawTool),
		})
	}
	resp.Usage = usageToUnified(gr.UsageMetadata)
	return resp
}

// usageToUnified translates usageMetadata. Gemini reports thought tokens
// outside candidatesTokenCount unless prompt+candidates already equals total,
// in which case the candidate count is inclusive (litellm's heuristic).
func usageToUnified(u *usageMetadata) *api.Usage {
	if u == nil {
		return nil
	}
	completion := u.CandidatesTokenCount
	if u.ThoughtsTokenCount > 0 && u.PromptTokenCount+u.CandidatesTokenCount != u.TotalTokenCount {
		completion += u.ThoughtsTokenCount
	}
	out := &api.Usage{
		PromptTokens:     u.PromptTokenCount,
		CompletionTokens: completion,
		TotalTokens:      u.TotalTokenCount,
	}
	if u.CachedContentTokenCount > 0 {
		out.PromptTokensDetails = &api.PromptTokensDetails{CachedTokens: u.CachedContentTokenCount}
	}
	if u.ThoughtsTokenCount > 0 {
		out.CompletionTokensDetails = &api.CompletionTokensDetails{ReasoningTokens: u.ThoughtsTokenCount}
	}
	return out
}

// ── inbound: Gemini stream → unified chunks ─────────────────────────────────

// streamState turns full GenerateContentResponse stream events into OpenAI
// deltas. Each functionCall arrives whole, so it becomes one complete tool
// call delta with a fresh index; ids are synthesized per stream.
type streamState struct {
	model    string
	id       string
	created  int64
	roleSent map[int]bool
	sawTool  map[int]bool
	toolIdx  map[int]int
	callSeq  int
}

func newStreamState(model string) *streamState {
	return &streamState{
		model:    model,
		created:  time.Now().Unix(),
		roleSent: map[int]bool{},
		sawTool:  map[int]bool{},
		toolIdx:  map[int]int{},
	}
}

// chunk translates one stream event; nil means the event carried nothing.
func (st *streamState) chunk(gr *genResponse) *api.ChatChunk {
	if st.id == "" && gr.ResponseID != "" {
		st.id = gr.ResponseID
	}
	out := &api.ChatChunk{
		ID:      st.id,
		Object:  "chat.completion.chunk",
		Created: st.created,
		Model:   st.model,
	}

	if len(gr.Candidates) == 0 && gr.PromptFeedback != nil && gr.PromptFeedback.BlockReason != "" {
		out.Choices = append(out.Choices, api.ChunkChoice{FinishReason: "content_filter"})
	}

	for i, cand := range gr.Candidates {
		idx := i
		if cand.Index != nil {
			idx = *cand.Index
		}
		cc := api.ChunkChoice{Index: idx}
		if !st.roleSent[idx] {
			cc.Delta.Role = "assistant"
			st.roleSent[idx] = true
		}
		if cand.Content != nil {
			var text, reasoning strings.Builder
			for _, pt := range cand.Content.Parts {
				switch {
				case pt.FunctionCall != nil:
					st.callSeq++
					st.sawTool[idx] = true
					tcIdx := st.toolIdx[idx]
					st.toolIdx[idx]++
					args := string(pt.FunctionCall.Args)
					if args == "" {
						args = "{}"
					}
					cc.Delta.ToolCalls = append(cc.Delta.ToolCalls, api.ToolCall{
						Index: &tcIdx,
						ID:    fmt.Sprintf("call_%d", st.callSeq),
						Type:  "function",
						Function: api.ToolCallFunction{
							Name:      pt.FunctionCall.Name,
							Arguments: args,
						},
					})
				case pt.Thought:
					reasoning.WriteString(pt.Text)
				default:
					text.WriteString(pt.Text)
				}
			}
			cc.Delta.Content = text.String()
			cc.Delta.ReasoningContent = reasoning.String()
		}
		if cand.FinishReason != "" {
			cc.FinishReason = mapFinishReason(cand.FinishReason, st.sawTool[idx])
		}
		out.Choices = append(out.Choices, cc)
	}

	out.Usage = usageToUnified(gr.UsageMetadata)
	if len(out.Choices) == 0 && out.Usage == nil {
		return nil
	}
	return out
}
