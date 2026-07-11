// Package oci implements the Oracle Cloud Infrastructure Generative AI
// adapter: POST {region endpoint}/20231130/actions/chat, authenticated with
// OCI's draft-cavage HTTP-Signature scheme (RSA-SHA256 over date,
// request-target, host, and body digest headers; keyId =
// tenancy/user/fingerprint). Models served with apiFormat GENERIC (Meta
// Llama, xAI Grok, Google Gemini, OpenAI on OCI, …) get the full chat
// surface including tools; cohere.* models use OCI's COHERE format, which
// this adapter supports for plain text chat only.
package oci

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

const (
	apiVersion = "20231130"
	// defaultMaxTokens: OCI's chat action requires maxTokens; litellm applies
	// a default the same way when the caller doesn't set one.
	defaultMaxTokens = 4096
)

func init() {
	api.Register("oci", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
	api.RegisterAlias("oracle", "oci")
}

// Provider is an OCI Generative AI adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func (p *Provider) Name() string { return "oci" }

// ── credentials ──────────────────────────────────────────────────────────────

type credentials struct {
	user        string
	fingerprint string
	tenancy     string
	region      string
	compartment string
	key         *rsa.PrivateKey
}

func (p *Provider) extra(key string) string {
	if p.cfg.Extra == nil {
		return ""
	}
	return p.cfg.Extra[key]
}

func (p *Provider) credentials() (*credentials, error) {
	pick := func(extraKey, env string) string {
		if v := p.extra(extraKey); v != "" {
			return v
		}
		return os.Getenv(env)
	}
	c := &credentials{
		user:        pick("user", "OCI_USER"),
		fingerprint: pick("fingerprint", "OCI_FINGERPRINT"),
		tenancy:     pick("tenancy", "OCI_TENANCY"),
		region:      pick("region", "OCI_REGION"),
		compartment: pick("compartment_id", "OCI_COMPARTMENT_ID"),
	}
	if c.region == "" {
		c.region = "us-ashburn-1"
	}
	if c.user == "" || c.fingerprint == "" || c.tenancy == "" || c.compartment == "" {
		return nil, &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "oci",
			Message: "missing OCI credentials: set OCI_USER, OCI_FINGERPRINT, OCI_TENANCY, OCI_COMPARTMENT_ID and OCI_KEY (PEM) or OCI_KEY_FILE (or the matching Extra keys)",
		}
	}

	pemData := pick("key", "OCI_KEY")
	if pemData != "" {
		// Env-carried keys often escape newlines.
		pemData = strings.ReplaceAll(pemData, `\n`, "\n")
	} else if path := pick("key_file", "OCI_KEY_FILE"); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, &api.Error{Type: api.ErrAuthentication, StatusCode: 401, Provider: "oci", Message: fmt.Sprintf("cannot read OCI_KEY_FILE: %v", err)}
		}
		pemData = string(b)
	}
	if pemData == "" {
		return nil, &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "oci",
			Message: "no OCI API key: set OCI_KEY (inline PEM) or OCI_KEY_FILE",
		}
	}
	key, err := parseRSAPrivateKey(pemData)
	if err != nil {
		return nil, &api.Error{Type: api.ErrAuthentication, StatusCode: 401, Provider: "oci", Message: err.Error()}
	}
	c.key = key
	return c, nil
}

func parseRSAPrivateKey(pemData string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, fmt.Errorf("OCI key is not PEM data")
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("cannot parse OCI private key: %v", err)
	}
	rsaKey, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("OCI key must be RSA (draft-cavage rsa-sha256 signing)")
	}
	return rsaKey, nil
}

// baseURL resolves the region inference endpoint.
func (p *Provider) baseURL(override, region string) string {
	base := p.cfg.BaseURL
	if v := os.Getenv("OCI_API_BASE"); base == "" && v != "" {
		base = v
	}
	if override != "" {
		base = override
	}
	if base == "" {
		base = fmt.Sprintf("https://inference.generativeai.%s.oci.oraclecloud.com", region)
	}
	return strings.TrimRight(base, "/")
}

// ── request signing (draft-cavage HTTP Signature, OCI profile) ───────────────

// signRequest sets the signed headers and the Authorization signature on an
// OCI POST. The signing string covers, in order: date, (request-target),
// host, content-length, content-type, x-content-sha256.
func signRequest(req *http.Request, body []byte, c *credentials, now time.Time) error {
	date := now.UTC().Format(http.TimeFormat)
	digest := base64.StdEncoding.EncodeToString(func() []byte { s := sha256.Sum256(body); return s[:] }())
	contentLength := fmt.Sprintf("%d", len(body))

	req.Header.Set("Date", date)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Length", contentLength)
	req.Header.Set("X-Content-Sha256", digest)

	path := req.URL.EscapedPath()
	if req.URL.RawQuery != "" {
		path += "?" + req.URL.RawQuery
	}
	signedNames := []string{"date", "(request-target)", "host", "content-length", "content-type", "x-content-sha256"}
	values := map[string]string{
		"date":             date,
		"(request-target)": strings.ToLower(req.Method) + " " + path,
		"host":             req.URL.Host,
		"content-length":   contentLength,
		"content-type":     "application/json",
		"x-content-sha256": digest,
	}
	var lines []string
	for _, name := range signedNames {
		lines = append(lines, name+": "+values[name])
	}
	signingString := strings.Join(lines, "\n")

	hashed := sha256.Sum256([]byte(signingString))
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.key, crypto.SHA256, hashed[:])
	if err != nil {
		return fmt.Errorf("sign OCI request: %v", err)
	}

	keyID := c.tenancy + "/" + c.user + "/" + c.fingerprint
	req.Header.Set("Authorization", fmt.Sprintf(
		`Signature version="1",keyId=%q,algorithm="rsa-sha256",headers=%q,signature=%q`,
		keyID, strings.Join(signedNames, " "), base64.StdEncoding.EncodeToString(sig)))
	return nil
}

// ── payload translation ──────────────────────────────────────────────────────

func cohereModel(model string) bool { return strings.HasPrefix(model, "cohere.") }

// ociMessage is one GENERIC-format chat message.
type ociMessage struct {
	Role       string           `json:"role"`
	Content    []ociContentPart `json:"content,omitempty"`
	ToolCalls  []ociToolCall    `json:"toolCalls,omitempty"`
	ToolCallID string           `json:"toolCallId,omitempty"`
}

type ociContentPart struct {
	Type string `json:"type"` // "TEXT"
	Text string `json:"text"`
}

type ociToolCall struct {
	ID        string `json:"id,omitempty"`
	Type      string `json:"type,omitempty"` // "FUNCTION"
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
}

func textParts(s string) []ociContentPart {
	return []ociContentPart{{Type: "TEXT", Text: s}}
}

// genericMessages renders unified messages in OCI GENERIC form.
func genericMessages(messages []api.Message) []ociMessage {
	out := make([]ociMessage, 0, len(messages))
	for _, m := range messages {
		switch m.Role {
		case "tool":
			out = append(out, ociMessage{Role: "TOOL", ToolCallID: m.ToolCallID, Content: textParts(m.Content.AsText())})
		case "assistant":
			msg := ociMessage{Role: "ASSISTANT"}
			if text := m.Content.AsText(); text != "" {
				msg.Content = textParts(text)
			}
			for _, tc := range m.ToolCalls {
				msg.ToolCalls = append(msg.ToolCalls, ociToolCall{
					ID: tc.ID, Type: "FUNCTION", Name: tc.Function.Name, Arguments: tc.Function.Arguments,
				})
			}
			out = append(out, msg)
		case "system":
			out = append(out, ociMessage{Role: "SYSTEM", Content: textParts(m.Content.AsText())})
		default:
			out = append(out, ociMessage{Role: "USER", Content: textParts(m.Content.AsText())})
		}
	}
	return out
}

// chatRequest assembles the vendor-specific chatRequest document.
func chatRequest(req *api.ChatRequest, stream bool) (map[string]any, error) {
	maxTokens := defaultMaxTokens
	if req.MaxTokens != nil {
		maxTokens = *req.MaxTokens
	} else if req.MaxCompletionTokens != nil {
		maxTokens = *req.MaxCompletionTokens
	}

	if cohereModel(req.Model) {
		if len(req.Tools) > 0 {
			return nil, &api.Error{
				Type: api.ErrBadRequest, StatusCode: 400, Provider: "oci",
				Message: "tool calling for cohere.* models on OCI is not supported; use a GENERIC-format model",
			}
		}
		var lastUser string
		var history []map[string]string
		var preamble []string
		for _, m := range req.Messages {
			switch m.Role {
			case "system":
				preamble = append(preamble, m.Content.AsText())
			case "assistant":
				history = append(history, map[string]string{"role": "CHATBOT", "message": m.Content.AsText()})
			default:
				history = append(history, map[string]string{"role": "USER", "message": m.Content.AsText()})
				lastUser = m.Content.AsText()
			}
		}
		if lastUser == "" {
			return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "oci", Message: "cohere.* models require at least one user message"}
		}
		// The final user turn is the `message`; history carries the rest.
		if n := len(history); n > 0 && history[n-1]["role"] == "USER" && history[n-1]["message"] == lastUser {
			history = history[:n-1]
		}
		cr := map[string]any{
			"apiFormat": "COHERE",
			"message":   lastUser,
			"isStream":  stream,
			"maxTokens": maxTokens,
		}
		if len(history) > 0 {
			cr["chatHistory"] = history
		}
		if len(preamble) > 0 {
			cr["preambleOverride"] = strings.Join(preamble, "\n")
		}
		if req.Temperature != nil {
			cr["temperature"] = *req.Temperature
		}
		if req.TopP != nil {
			cr["topP"] = *req.TopP
		}
		if len(req.Stop) > 0 {
			cr["stopSequences"] = []string(req.Stop)
		}
		return cr, nil
	}

	cr := map[string]any{
		"apiFormat": "GENERIC",
		"messages":  genericMessages(req.Messages),
		"isStream":  stream,
		"maxTokens": maxTokens,
	}
	if req.Temperature != nil {
		cr["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		cr["topP"] = *req.TopP
	}
	if req.FrequencyPenalty != nil {
		cr["frequencyPenalty"] = *req.FrequencyPenalty
	}
	if req.PresencePenalty != nil {
		cr["presencePenalty"] = *req.PresencePenalty
	}
	if req.N != nil {
		cr["numGenerations"] = *req.N
	}
	if req.Seed != nil {
		cr["seed"] = *req.Seed
	}
	if len(req.Stop) > 0 {
		cr["stop"] = []string(req.Stop)
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			tool := map[string]any{"type": "FUNCTION", "name": t.Function.Name}
			if t.Function.Description != "" {
				tool["description"] = t.Function.Description
			}
			if len(t.Function.Parameters) > 0 {
				tool["parameters"] = json.RawMessage(t.Function.Parameters)
			}
			tools = append(tools, tool)
		}
		cr["tools"] = tools
	}
	if tc := req.ToolChoice; tc != nil {
		if raw, err := json.Marshal(tc); err == nil {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				cr["toolChoice"] = map[string]string{"type": strings.ToUpper(s)}
			}
		}
	}
	return cr, nil
}

// payload assembles the full /actions/chat body.
func payload(req *api.ChatRequest, compartment string, stream bool) ([]byte, error) {
	cr, err := chatRequest(req, stream)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"compartmentId": compartment,
		"servingMode":   map[string]string{"servingType": "ON_DEMAND", "modelId": req.Model},
		"chatRequest":   cr,
	})
}

// ── responses ────────────────────────────────────────────────────────────────

// ociChatResponse is the subset of the chat action's response we consume,
// covering both apiFormats.
type ociChatResponse struct {
	ModelID      string `json:"modelId"`
	ChatResponse struct {
		// GENERIC
		Choices []struct {
			Index   int `json:"index"`
			Message struct {
				Role      string           `json:"role"`
				Content   []ociContentPart `json:"content"`
				ToolCalls []ociToolCall    `json:"toolCalls"`
			} `json:"message"`
			FinishReason string `json:"finishReason"`
		} `json:"choices"`
		// COHERE
		Text string `json:"text"`

		FinishReason string `json:"finishReason"`
		Usage        struct {
			PromptTokens     int `json:"promptTokens"`
			CompletionTokens int `json:"completionTokens"`
			TotalTokens      int `json:"totalTokens"`
		} `json:"usage"`
	} `json:"chatResponse"`
}

// finishReason collapses OCI's finish vocabulary onto OpenAI's.
func finishReason(s string) string {
	switch strings.ToLower(s) {
	case "", "stop", "complete", "finished":
		return "stop"
	case "length", "max_tokens":
		return "length"
	case "tool_calls", "tool_call":
		return "tool_calls"
	default:
		return "stop"
	}
}

func joinText(parts []ociContentPart) string {
	var b strings.Builder
	for _, part := range parts {
		b.WriteString(part.Text)
	}
	return b.String()
}

func (p *Provider) do(ctx context.Context, req *api.ChatRequest, stream bool) (*http.Response, error) {
	creds, err := p.credentials()
	if err != nil {
		return nil, err
	}
	body, err := payload(req, creds.compartment, stream)
	if err != nil {
		return nil, err
	}

	u := p.baseURL(req.BaseURL, creds.region) + "/" + apiVersion + "/actions/chat"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, api.WrapTransport("oci", req.Model, err)
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	if stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	}
	if err := signRequest(httpReq, body, creds, time.Now()); err != nil {
		return nil, &api.Error{Type: api.ErrAuthentication, StatusCode: 401, Provider: "oci", Message: err.Error()}
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("oci", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("oci", req.Model, resp.StatusCode, raw, 0)
	}
	return resp, nil
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	resp, err := p.do(ctx, req, false)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out ociChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "oci",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}

	res := &api.ChatResponse{
		Object:   "chat.completion",
		Created:  time.Now().Unix(),
		Model:    req.Model,
		Provider: "oci",
	}
	if u := out.ChatResponse.Usage; u.PromptTokens > 0 || u.CompletionTokens > 0 {
		total := u.TotalTokens
		if total == 0 {
			total = u.PromptTokens + u.CompletionTokens
		}
		res.Usage = &api.Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: total}
	}

	if len(out.ChatResponse.Choices) > 0 {
		for _, c := range out.ChatResponse.Choices {
			msg := api.Message{Role: "assistant"}
			if text := joinText(c.Message.Content); text != "" {
				msg.Content = api.TextContent(text)
			}
			for _, tc := range c.Message.ToolCalls {
				msg.ToolCalls = append(msg.ToolCalls, api.ToolCall{
					ID: tc.ID, Type: "function",
					Function: api.ToolCallFunction{Name: tc.Name, Arguments: tc.Arguments},
				})
			}
			fr := finishReason(c.FinishReason)
			if len(msg.ToolCalls) > 0 && fr == "stop" {
				fr = "tool_calls"
			}
			res.Choices = append(res.Choices, api.Choice{Index: c.Index, Message: msg, FinishReason: fr})
		}
		return res, nil
	}
	// COHERE format: a single text answer.
	res.Choices = []api.Choice{{
		Message:      api.Message{Role: "assistant", Content: api.TextContent(out.ChatResponse.Text)},
		FinishReason: finishReason(out.ChatResponse.FinishReason),
	}}
	return res, nil
}

// ociStreamChunk covers both apiFormats' SSE chunk shapes.
type ociStreamChunk struct {
	Index   int `json:"index"`
	Message struct {
		Role      string           `json:"role"`
		Content   []ociContentPart `json:"content"`
		ToolCalls []ociToolCall    `json:"toolCalls"`
	} `json:"message"`
	Text         string `json:"text"` // COHERE
	FinishReason string `json:"finishReason"`
	Usage        *struct {
		PromptTokens     int `json:"promptTokens"`
		CompletionTokens int `json:"completionTokens"`
		TotalTokens      int `json:"totalTokens"`
	} `json:"usage"`
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	resp, err := p.do(ctx, req, true)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	created := time.Now().Unix()
	sentRole := false
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport("oci", req.Model, err)
			}
			if ev.IsDone() || len(ev.Data) == 0 {
				if ev.IsDone() {
					return nil, io.EOF
				}
				continue
			}
			var raw ociStreamChunk
			if err := json.Unmarshal(ev.Data, &raw); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: "oci",
					Model: req.Model, Message: fmt.Sprintf("malformed stream chunk: %v", err),
				}
			}

			delta := api.Delta{Content: joinText(raw.Message.Content) + raw.Text}
			for i, tc := range raw.Message.ToolCalls {
				idx := i
				delta.ToolCalls = append(delta.ToolCalls, api.ToolCall{
					Index: &idx, ID: tc.ID, Type: "function",
					Function: api.ToolCallFunction{Name: tc.Name, Arguments: tc.Arguments},
				})
			}
			if !sentRole {
				delta.Role = "assistant"
				sentRole = true
			}

			chunk := &api.ChatChunk{
				Object: "chat.completion.chunk", Created: created, Model: req.Model,
				Choices: []api.ChunkChoice{{Index: raw.Index, Delta: delta}},
			}
			if raw.FinishReason != "" {
				chunk.Choices[0].FinishReason = finishReason(raw.FinishReason)
			}
			if raw.Usage != nil {
				total := raw.Usage.TotalTokens
				if total == 0 {
					total = raw.Usage.PromptTokens + raw.Usage.CompletionTokens
				}
				chunk.Usage = &api.Usage{PromptTokens: raw.Usage.PromptTokens, CompletionTokens: raw.Usage.CompletionTokens, TotalTokens: total}
			}
			return chunk, nil
		}
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("oci", "embeddings")
}
