package vertex

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

// ── Gemini wire format (identical to Google AI Studio's generateContent) ────

type generateContentRequest struct {
	Contents          []content         `json:"contents"`
	SystemInstruction *content          `json:"systemInstruction,omitempty"`
	Tools             []toolDecl        `json:"tools,omitempty"`
	ToolConfig        *toolConfig       `json:"toolConfig,omitempty"`
	GenerationConfig  *generationConfig `json:"generationConfig,omitempty"`
}

type content struct {
	Role  string `json:"role,omitempty"` // "user" | "model"
	Parts []part `json:"parts"`
}

type part struct {
	Text             string            `json:"text,omitempty"`
	Thought          bool              `json:"thought,omitempty"`
	InlineData       *blob             `json:"inlineData,omitempty"`
	FileData         *fileData         `json:"fileData,omitempty"`
	FunctionCall     *functionCall     `json:"functionCall,omitempty"`
	FunctionResponse *functionResponse `json:"functionResponse,omitempty"`
}

type blob struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type fileData struct {
	MimeType string `json:"mimeType,omitempty"`
	FileURI  string `json:"fileUri"`
}

type functionCall struct {
	Name string          `json:"name"`
	Args json.RawMessage `json:"args,omitempty"`
}

type functionResponse struct {
	Name     string          `json:"name"`
	Response json.RawMessage `json:"response"`
}

type toolDecl struct {
	FunctionDeclarations []functionDeclaration `json:"functionDeclarations,omitempty"`
}

type functionDeclaration struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

type toolConfig struct {
	FunctionCallingConfig *functionCallingConfig `json:"functionCallingConfig,omitempty"`
}

type functionCallingConfig struct {
	Mode                 string   `json:"mode,omitempty"` // AUTO | ANY | NONE
	AllowedFunctionNames []string `json:"allowedFunctionNames,omitempty"`
}

type generationConfig struct {
	Temperature      *float64        `json:"temperature,omitempty"`
	TopP             *float64        `json:"topP,omitempty"`
	MaxOutputTokens  *int            `json:"maxOutputTokens,omitempty"`
	CandidateCount   *int            `json:"candidateCount,omitempty"`
	StopSequences    []string        `json:"stopSequences,omitempty"`
	Seed             *int            `json:"seed,omitempty"`
	PresencePenalty  *float64        `json:"presencePenalty,omitempty"`
	FrequencyPenalty *float64        `json:"frequencyPenalty,omitempty"`
	ResponseMimeType string          `json:"responseMimeType,omitempty"`
	ResponseSchema   json.RawMessage `json:"responseSchema,omitempty"`
	ThinkingConfig   *thinkingConfig `json:"thinkingConfig,omitempty"`
}

type thinkingConfig struct {
	IncludeThoughts bool `json:"includeThoughts,omitempty"`
	ThinkingBudget  *int `json:"thinkingBudget,omitempty"`
}

type generateContentResponse struct {
	ResponseID     string          `json:"responseId,omitempty"`
	ModelVersion   string          `json:"modelVersion,omitempty"`
	Candidates     []candidate     `json:"candidates,omitempty"`
	PromptFeedback *promptFeedback `json:"promptFeedback,omitempty"`
	UsageMetadata  *usageMetadata  `json:"usageMetadata,omitempty"`
}

type candidate struct {
	Index        int      `json:"index,omitempty"`
	Content      *content `json:"content,omitempty"`
	FinishReason string   `json:"finishReason,omitempty"`
}

type promptFeedback struct {
	BlockReason string `json:"blockReason,omitempty"`
}

type usageMetadata struct {
	PromptTokenCount        int `json:"promptTokenCount"`
	CandidatesTokenCount    int `json:"candidatesTokenCount"`
	TotalTokenCount         int `json:"totalTokenCount"`
	CachedContentTokenCount int `json:"cachedContentTokenCount,omitempty"`
	ThoughtsTokenCount      int `json:"thoughtsTokenCount,omitempty"`
}

// newID mints an OpenAI-style identifier for the ids Gemini doesn't assign
// (tool calls, response ids).
func newID(prefix string) string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

// ── outbound: unified request → Gemini ──────────────────────────────────────

// geminiRequestFromUnified translates a unified request. System/developer
// messages hoist into systemInstruction; consecutive same-role turns merge
// (Gemini requires user/model alternation).
func geminiRequestFromUnified(req *api.ChatRequest) (*generateContentRequest, error) {
	out := &generateContentRequest{}

	// OpenAI tool messages reference calls by id; Gemini functionResponse
	// parts reference them by function name. Recover names from history.
	callNames := map[string]string{}
	for _, m := range req.Messages {
		for _, tc := range m.ToolCalls {
			if tc.ID != "" && tc.Function.Name != "" {
				callNames[tc.ID] = tc.Function.Name
			}
		}
	}

	var systemParts []string
	for _, m := range req.Messages {
		switch m.Role {
		case "system", "developer":
			systemParts = append(systemParts, m.Content.AsText())

		case "user":
			parts, err := userParts(m)
			if err != nil {
				return nil, err
			}
			appendContent(out, "user", parts)

		case "assistant":
			var parts []part
			if text := m.Content.AsText(); text != "" {
				parts = append(parts, part{Text: text})
			}
			for _, tc := range m.ToolCalls {
				parts = append(parts, part{FunctionCall: &functionCall{
					Name: tc.Function.Name,
					Args: argsToObject(tc.Function.Arguments),
				}})
			}
			appendContent(out, "model", parts)

		case "tool":
			name := callNames[m.ToolCallID]
			if name == "" {
				name = m.Name
			}
			if name == "" {
				name = m.ToolCallID
			}
			// Gemini requires the response to be an object; wrap the tool
			// output like litellm does.
			resp, _ := json.Marshal(map[string]any{"content": m.Content.AsText()})
			appendContent(out, "user", []part{{FunctionResponse: &functionResponse{Name: name, Response: resp}}})

		default:
			return nil, fmt.Errorf("unsupported message role %q", m.Role)
		}
	}
	if len(systemParts) > 0 {
		out.SystemInstruction = &content{Parts: []part{{Text: strings.Join(systemParts, "\n\n")}}}
	}

	var decls []functionDeclaration
	for _, t := range req.Tools {
		decls = append(decls, functionDeclaration{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			Parameters:  sanitizeSchema(t.Function.Parameters),
		})
	}
	if len(decls) > 0 {
		out.Tools = []toolDecl{{FunctionDeclarations: decls}}
	}

	if tc := req.ToolChoice; tc != nil {
		fcc := &functionCallingConfig{}
		switch tc.Mode {
		case "auto":
			fcc.Mode = "AUTO"
		case "none":
			fcc.Mode = "NONE"
		case "required":
			fcc.Mode = "ANY"
		case "function":
			fcc.Mode = "ANY"
			fcc.AllowedFunctionNames = []string{tc.FunctionName}
		}
		if fcc.Mode != "" {
			out.ToolConfig = &toolConfig{FunctionCallingConfig: fcc}
		}
	}

	gc := &generationConfig{
		Temperature:      req.Temperature,
		TopP:             req.TopP,
		CandidateCount:   req.N,
		StopSequences:    []string(req.Stop),
		Seed:             req.Seed,
		PresencePenalty:  req.PresencePenalty,
		FrequencyPenalty: req.FrequencyPenalty,
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
	if req.ReasoningEffort != "" {
		budget := thinkingBudget(req.ReasoningEffort)
		gc.ThinkingConfig = &thinkingConfig{IncludeThoughts: true, ThinkingBudget: &budget}
	}
	// Omit an all-defaults generationConfig from the wire entirely.
	if b, err := json.Marshal(gc); err == nil && string(b) != "{}" {
		out.GenerationConfig = gc
	}

	return out, nil
}

func appendContent(out *generateContentRequest, role string, parts []part) {
	if len(parts) == 0 {
		return
	}
	if n := len(out.Contents); n > 0 && out.Contents[n-1].Role == role {
		out.Contents[n-1].Parts = append(out.Contents[n-1].Parts, parts...)
		return
	}
	out.Contents = append(out.Contents, content{Role: role, Parts: parts})
}

func userParts(m api.Message) ([]part, error) {
	if m.Content.Parts == nil {
		return []part{{Text: m.Content.AsText()}}, nil
	}
	var parts []part
	for _, cp := range m.Content.Parts {
		switch cp.Type {
		case "text":
			parts = append(parts, part{Text: cp.Text})
		case "image_url":
			if cp.ImageURL == nil {
				continue
			}
			ip, err := imagePart(cp.ImageURL.URL)
			if err != nil {
				return nil, err
			}
			parts = append(parts, ip)
		default:
			// Audio/file parts have no Gemini mapping here; dropped like any
			// other unsupported parameter.
		}
	}
	if len(parts) == 0 {
		parts = []part{{Text: ""}}
	}
	return parts, nil
}

// imagePart converts an OpenAI image_url: data: URIs become inlineData,
// remote URLs become fileData with the mime type inferred from the extension.
func imagePart(u string) (part, error) {
	if strings.HasPrefix(u, "data:") {
		rest := strings.TrimPrefix(u, "data:")
		semi := strings.Index(rest, ";base64,")
		if semi < 0 {
			return part{}, fmt.Errorf("unsupported image data URI (expected ;base64,)")
		}
		return part{InlineData: &blob{MimeType: rest[:semi], Data: rest[semi+len(";base64,"):]}}, nil
	}
	return part{FileData: &fileData{MimeType: mimeFromURL(u), FileURI: u}}, nil
}

func mimeFromURL(u string) string {
	switch strings.ToLower(path.Ext(strings.SplitN(u, "?", 2)[0])) {
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return "image/jpeg"
	}
}

// argsToObject renders an OpenAI arguments string as the JSON object
// functionCall.args requires; malformed or non-object arguments are preserved
// under a wrapper key instead of being discarded.
func argsToObject(args string) json.RawMessage {
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

// geminiUnsupportedSchemaKeys are JSON Schema fields Vertex's OpenAPI-subset
// validator rejects; litellm strips the same set.
var geminiUnsupportedSchemaKeys = []string{"$schema", "$id", "additionalProperties", "strict"}

// sanitizeSchema strips unsupported keys recursively. A schema that isn't
// valid JSON passes through untouched so the backend reports the real error.
func sanitizeSchema(schema json.RawMessage) json.RawMessage {
	if len(schema) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(schema, &v); err != nil {
		return schema
	}
	out, err := json.Marshal(stripKeys(v))
	if err != nil {
		return schema
	}
	return out
}

func stripKeys(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for _, k := range geminiUnsupportedSchemaKeys {
			delete(t, k)
		}
		for k, val := range t {
			t[k] = stripKeys(val)
		}
		return t
	case []any:
		for i, val := range t {
			t[i] = stripKeys(val)
		}
		return t
	default:
		return v
	}
}

// thinkingBudget maps OpenAI reasoning_effort onto Gemini thinking budgets
// (litellm's defaults).
func thinkingBudget(effort string) int {
	switch effort {
	case "minimal":
		return 128
	case "low":
		return 1024
	case "high":
		return 4096
	default: // "medium" and unknown values
		return 2048
	}
}

// ── inbound: Gemini response → unified ──────────────────────────────────────

func geminiResponseToUnified(model string, gr *generateContentResponse) *api.ChatResponse {
	out := &api.ChatResponse{
		ID:      gr.ResponseID,
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   model,
		Usage:   usageToUnified(gr.UsageMetadata),
	}
	if out.ID == "" {
		out.ID = newID("chatcmpl")
	}
	if gr.ModelVersion != "" {
		out.Model = gr.ModelVersion
	}

	for i, cand := range gr.Candidates {
		msg, hasTools := candidateMessage(cand, nil)
		finish := finishToUnified(cand.FinishReason)
		if hasTools && (finish == "" || finish == "stop") {
			finish = "tool_calls"
		}
		if finish == "" {
			finish = "stop"
		}
		out.Choices = append(out.Choices, api.Choice{Index: i, Message: msg, FinishReason: finish})
	}
	// A prompt-level block returns no candidates; surface it as a
	// content-filtered empty choice rather than an empty response.
	if len(out.Choices) == 0 && gr.PromptFeedback != nil && gr.PromptFeedback.BlockReason != "" {
		out.Choices = append(out.Choices, api.Choice{
			Index:        0,
			Message:      api.Message{Role: "assistant"},
			FinishReason: "content_filter",
		})
	}
	return out
}

// candidateMessage folds one candidate's parts into an assistant message.
// nextTool, when non-nil, assigns streaming tool indices.
func candidateMessage(cand candidate, nextTool *int) (api.Message, bool) {
	msg := api.Message{Role: "assistant"}
	var text, reasoning strings.Builder
	if cand.Content != nil {
		for _, pt := range cand.Content.Parts {
			switch {
			case pt.FunctionCall != nil:
				args := "{}"
				if len(pt.FunctionCall.Args) > 0 {
					args = string(pt.FunctionCall.Args)
				}
				tc := api.ToolCall{
					ID:       newID("call"),
					Type:     "function",
					Function: api.ToolCallFunction{Name: pt.FunctionCall.Name, Arguments: args},
				}
				if nextTool != nil {
					idx := *nextTool
					*nextTool++
					tc.Index = &idx
				}
				msg.ToolCalls = append(msg.ToolCalls, tc)
			case pt.Thought:
				reasoning.WriteString(pt.Text)
			default:
				text.WriteString(pt.Text)
			}
		}
	}
	if text.Len() > 0 {
		msg.Content = api.TextContent(text.String())
	}
	msg.ReasoningContent = reasoning.String()
	return msg, len(msg.ToolCalls) > 0
}

func finishToUnified(fr string) string {
	switch fr {
	case "":
		return ""
	case "STOP":
		return "stop"
	case "MAX_TOKENS":
		return "length"
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY":
		return "content_filter"
	default:
		return "stop"
	}
}

// usageToUnified maps usageMetadata; candidatesTokenCount excludes thinking
// tokens, which Gemini reports separately in thoughtsTokenCount.
func usageToUnified(u *usageMetadata) *api.Usage {
	if u == nil {
		return nil
	}
	completion := u.CandidatesTokenCount + u.ThoughtsTokenCount
	out := &api.Usage{
		PromptTokens:     u.PromptTokenCount,
		CompletionTokens: completion,
		TotalTokens:      u.TotalTokenCount,
	}
	if out.TotalTokens == 0 {
		out.TotalTokens = out.PromptTokens + completion
	}
	if u.CachedContentTokenCount > 0 {
		out.PromptTokensDetails = &api.PromptTokensDetails{CachedTokens: u.CachedContentTokenCount}
	}
	if u.ThoughtsTokenCount > 0 {
		out.CompletionTokensDetails = &api.CompletionTokensDetails{ReasoningTokens: u.ThoughtsTokenCount}
	}
	return out
}

// ── streaming ────────────────────────────────────────────────────────────────

// geminiStreamState folds streamed generateContent chunks into unified
// deltas: the assistant role is emitted once, tool calls get sequential
// OpenAI indices across the stream, and a trailing STOP after tool calls is
// reported as tool_calls.
type geminiStreamState struct {
	id       string
	model    string
	created  int64
	sentRole bool
	sawTool  bool
	nextTool int
}

func newGeminiStreamState(model string) *geminiStreamState {
	return &geminiStreamState{id: newID("chatcmpl"), model: model, created: time.Now().Unix()}
}

// chunk converts one streamed response; nil means the event carried nothing
// the unified stream represents.
func (s *geminiStreamState) chunk(gr *generateContentResponse) *api.ChatChunk {
	if gr.ResponseID != "" {
		s.id = gr.ResponseID
	}
	if gr.ModelVersion != "" {
		s.model = gr.ModelVersion
	}
	out := &api.ChatChunk{
		ID:      s.id,
		Object:  "chat.completion.chunk",
		Created: s.created,
		Model:   s.model,
		Usage:   usageToUnified(gr.UsageMetadata),
	}

	for _, cand := range gr.Candidates {
		msg, hasTools := candidateMessage(cand, &s.nextTool)
		if hasTools {
			s.sawTool = true
		}
		delta := api.Delta{
			Content:          msg.Content.AsText(),
			ReasoningContent: msg.ReasoningContent,
			ToolCalls:        msg.ToolCalls,
		}
		if !s.sentRole {
			delta.Role = "assistant"
			s.sentRole = true
		}
		finish := finishToUnified(cand.FinishReason)
		if finish == "stop" && s.sawTool {
			finish = "tool_calls"
		}
		out.Choices = append(out.Choices, api.ChunkChoice{Index: cand.Index, Delta: delta, FinishReason: finish})
	}
	if len(out.Choices) == 0 && out.Usage == nil {
		return nil
	}
	return out
}

// ── provider methods ─────────────────────────────────────────────────────────

func (p *Provider) geminiComplete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	greq, err := geminiRequestFromUnified(req)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	payload, err := json.Marshal(greq)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	url, err := p.modelURL(req.BaseURL, "google", req.Model, "generateContent")
	if err != nil {
		return nil, err
	}

	resp, err := p.do(ctx, url, req.Model, req.APIKey, req.Headers, payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var gr generateContentResponse
	if err := json.NewDecoder(resp.Body).Decode(&gr); err != nil {
		return nil, malformed(req.Model, err)
	}
	out := geminiResponseToUnified(req.Model, &gr)
	out.Provider = providerName
	return out, nil
}

func (p *Provider) geminiStream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	greq, err := geminiRequestFromUnified(req)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	payload, err := json.Marshal(greq)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	url, err := p.modelURL(req.BaseURL, "google", req.Model, "streamGenerateContent")
	if err != nil {
		return nil, err
	}
	url += "?alt=sse"

	resp, err := p.do(ctx, url, req.Model, req.APIKey, req.Headers, payload)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	st := newGeminiStreamState(req.Model)
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport(providerName, req.Model, err)
			}
			if ev.IsDone() || len(ev.Data) == 0 {
				continue
			}
			// Vertex interleaves {"error": ...} objects mid-stream on failure;
			// they would otherwise decode into an empty response and be dropped.
			if apiErr := sniffStreamError(req.Model, ev.Data); apiErr != nil {
				return nil, apiErr
			}
			var gr generateContentResponse
			if err := json.Unmarshal(ev.Data, &gr); err != nil {
				return nil, malformed(req.Model, err)
			}
			if chunk := st.chunk(&gr); chunk != nil {
				return chunk, nil
			}
		}
	}, resp.Body.Close), nil
}

// sniffStreamError detects an in-band {"error": ...} payload in a stream and
// classifies it like a non-2xx response.
func sniffStreamError(model string, data []byte) *api.Error {
	var probe struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &probe); err != nil || probe.Error == nil {
		return nil
	}
	status := probe.Error.Code
	if status == 0 {
		status = 500
	}
	return api.ErrorFromHTTP(providerName, model, status, data, 0)
}

// ── embeddings ───────────────────────────────────────────────────────────────

type predictRequest struct {
	Instances  []embedInstance  `json:"instances"`
	Parameters *embedParameters `json:"parameters,omitempty"`
}

type embedInstance struct {
	Content string `json:"content"`
}

type embedParameters struct {
	OutputDimensionality *int `json:"outputDimensionality,omitempty"`
}

type predictResponse struct {
	Predictions []struct {
		Embeddings struct {
			Values     []float64 `json:"values"`
			Statistics *struct {
				TokenCount int `json:"token_count"`
			} `json:"statistics,omitempty"`
		} `json:"embeddings"`
	} `json:"predictions"`
}

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	if isClaude(req.Model) {
		return nil, api.NotSupported(providerName, "embeddings for claude models")
	}

	body := predictRequest{}
	for _, in := range req.Input {
		body.Instances = append(body.Instances, embedInstance{Content: in})
	}
	if req.Dimensions != nil {
		body.Parameters = &embedParameters{OutputDimensionality: req.Dimensions}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	url, err := p.modelURL(req.BaseURL, "google", req.Model, "predict")
	if err != nil {
		return nil, err
	}

	resp, err := p.do(ctx, url, req.Model, req.APIKey, req.Headers, payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var pr predictResponse
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return nil, malformed(req.Model, err)
	}
	out := &api.EmbeddingResponse{Object: "list", Model: req.Model}
	tokens := 0
	for i, pred := range pr.Predictions {
		out.Data = append(out.Data, api.Embedding{Object: "embedding", Index: i, Embedding: pred.Embeddings.Values})
		if pred.Embeddings.Statistics != nil {
			tokens += pred.Embeddings.Statistics.TokenCount
		}
	}
	if tokens > 0 {
		out.Usage = &api.Usage{PromptTokens: tokens, TotalTokens: tokens}
	}
	return out, nil
}
