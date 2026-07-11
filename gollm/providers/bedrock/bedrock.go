// Package bedrock implements the AWS Bedrock adapter over the Converse and
// ConverseStream APIs. Everything AWS-specific — SigV4 request signing and
// vnd.amazon.eventstream response framing — is implemented here on the
// stdlib, so no AWS SDK dependency is taken. Model ids pass through verbatim
// ("anthropic.claude-sonnet-4-5-20250929-v1:0", "us.anthropic..." inference
// profiles, full ARNs).
package bedrock

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

// Provider is a Bedrock Converse adapter instance.
type Provider struct {
	cfg api.ProviderConfig
}

func init() {
	api.Register("bedrock", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg}, nil
	})
}

func (p *Provider) Name() string { return "bedrock" }

// credentials resolves the AWS credential set for the bedrock provider.
func (p *Provider) credentials() (awsCredentials, error) {
	return resolveAWSCredentials(p.cfg, "bedrock")
}

// resolveAWSCredentials resolves an AWS credential set: cfg.Extra first, then
// the conventional environment variables. Region deliberately has no default —
// a guessed region signs for the wrong endpoint and surfaces as an opaque 403
// instead of this actionable error. Shared by the bedrock and sagemaker
// providers.
func resolveAWSCredentials(cfg api.ProviderConfig, provider string) (awsCredentials, error) {
	pick := func(extraKey, env string) string {
		if v := cfg.Extra[extraKey]; v != "" {
			return v
		}
		return os.Getenv(env)
	}
	creds := awsCredentials{
		accessKeyID:     pick("access_key_id", "AWS_ACCESS_KEY_ID"),
		secretAccessKey: pick("secret_access_key", "AWS_SECRET_ACCESS_KEY"),
		sessionToken:    pick("session_token", "AWS_SESSION_TOKEN"),
		region:          pick("region", "AWS_REGION"),
	}
	if creds.accessKeyID == "" || creds.secretAccessKey == "" {
		return awsCredentials{}, &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: provider,
			Message: fmt.Sprintf("no AWS credentials for %s: set Extra access_key_id/secret_access_key or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY", provider),
		}
	}
	if creds.region == "" {
		return awsCredentials{}, &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: provider,
			Message: fmt.Sprintf("no AWS region for %s: set Extra region or AWS_REGION", provider),
		}
	}
	return creds, nil
}

// endpoint builds the Converse URL. The model id is strictly percent-escaped
// (Bedrock ids carry ":", ARNs carry "/") and the escaped form is pinned in
// RawPath so the path SigV4 signs is byte-identical to the wire path.
func (p *Provider) endpoint(override, region, model, action string) (*url.URL, error) {
	base := "https://bedrock-runtime." + region + ".amazonaws.com"
	if p.cfg.BaseURL != "" {
		base = p.cfg.BaseURL
	}
	if override != "" {
		base = override
	}
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return nil, &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: "bedrock",
			Message: fmt.Sprintf("invalid base URL %q: %v", base, err),
		}
	}
	u.RawPath = u.EscapedPath() + "/model/" + awsEscape(model) + "/" + action
	u.Path += "/model/" + model + "/" + action
	return u, nil
}

func (p *Provider) do(ctx context.Context, req *api.ChatRequest, action string, payload []byte) (*http.Response, error) {
	creds, err := p.credentials()
	if err != nil {
		return nil, err
	}
	u, err := p.endpoint(req.BaseURL, creds.region, req.Model, action)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("bedrock", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	// Sign last so the signature covers the final content-type.
	signRequest(httpReq, payload, creds, "bedrock", time.Now())

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("bedrock", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("bedrock", req.Model, resp.StatusCode, raw, retryAfter(resp))
	}
	return resp, nil
}

func retryAfter(resp *http.Response) time.Duration {
	if v := resp.Header.Get("Retry-After"); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return 0
}

func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	payload, err := marshalConverse(req)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "bedrock", Model: req.Model, Message: err.Error()}
	}

	// Per-request timeout bounds the non-streaming call as a whole; Stream
	// skips it so long generations aren't severed mid-flight.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	resp, err := p.do(ctx, req, "converse", payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var cr converseResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "bedrock",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	return responseToUnified(&cr, req.Model), nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	payload, err := marshalConverse(req)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "bedrock", Model: req.Model, Message: err.Error()}
	}

	resp, err := p.do(ctx, req, "converse-stream", payload)
	if err != nil {
		return nil, err
	}

	es := newEventStreamReader(resp.Body)
	st := &streamState{
		id:      newID(),
		created: time.Now().Unix(),
		model:   req.Model,
		toolIdx: map[int]int{},
	}
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			msg, err := es.next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport("bedrock", req.Model, err)
			}
			chunk, err := st.event(msg)
			if err != nil {
				return nil, err
			}
			if chunk != nil {
				return chunk, nil
			}
		}
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("bedrock", "embeddings")
}

// ── ConverseStream event mapping ──

// streamState maps ConverseStream events to OpenAI chunks. Bedrock indexes
// content blocks across all block types while OpenAI tool indices count only
// tool calls, so toolIdx remaps contentBlockIndex → sequential tool index.
type streamState struct {
	id      string
	created int64
	model   string
	toolIdx map[int]int
}

// converseEvent is the union of every ConverseStream event payload.
type converseEvent struct {
	Role              string `json:"role"`              // messageStart
	ContentBlockIndex int    `json:"contentBlockIndex"` // contentBlock*
	Start             *struct {
		ToolUse *struct {
			ToolUseID string `json:"toolUseId"`
			Name      string `json:"name"`
		} `json:"toolUse"`
	} `json:"start"` // contentBlockStart
	Delta *struct {
		Text    string `json:"text"`
		ToolUse *struct {
			Input string `json:"input"` // partial-JSON argument fragment
		} `json:"toolUse"`
		ReasoningContent *struct {
			Text string `json:"text"`
		} `json:"reasoningContent"`
	} `json:"delta"` // contentBlockDelta
	StopReason string         `json:"stopReason"` // messageStop
	Usage      *converseUsage `json:"usage"`      // metadata
}

// event maps one frame to at most one chunk; nil means nothing to surface.
func (s *streamState) event(msg *eventMessage) (*api.ChatChunk, error) {
	if mt := msg.headers[":message-type"]; mt != "" && mt != "event" {
		return nil, streamException(s.model, msg)
	}
	var ev converseEvent
	if err := json.Unmarshal(msg.payload, &ev); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "bedrock",
			Model: s.model, Message: fmt.Sprintf("malformed stream event: %v", err),
		}
	}

	switch msg.headers[":event-type"] {
	case "messageStart":
		role := ev.Role
		if role == "" {
			role = "assistant"
		}
		return s.chunk(api.ChunkChoice{Delta: api.Delta{Role: role}}), nil

	case "contentBlockStart":
		if ev.Start == nil || ev.Start.ToolUse == nil {
			return nil, nil
		}
		idx := len(s.toolIdx)
		s.toolIdx[ev.ContentBlockIndex] = idx
		return s.chunk(api.ChunkChoice{Delta: api.Delta{ToolCalls: []api.ToolCall{{
			Index:    &idx,
			ID:       ev.Start.ToolUse.ToolUseID,
			Type:     "function",
			Function: api.ToolCallFunction{Name: ev.Start.ToolUse.Name},
		}}}}), nil

	case "contentBlockDelta":
		if ev.Delta == nil {
			return nil, nil
		}
		switch {
		case ev.Delta.ToolUse != nil:
			idx, ok := s.toolIdx[ev.ContentBlockIndex]
			if !ok { // defensive: delta without a start frame
				idx = len(s.toolIdx)
				s.toolIdx[ev.ContentBlockIndex] = idx
			}
			return s.chunk(api.ChunkChoice{Delta: api.Delta{ToolCalls: []api.ToolCall{{
				Index:    &idx,
				Function: api.ToolCallFunction{Arguments: ev.Delta.ToolUse.Input},
			}}}}), nil
		case ev.Delta.ReasoningContent != nil:
			// Signature/redacted fragments have no unified slot; only text
			// reasoning surfaces.
			if ev.Delta.ReasoningContent.Text == "" {
				return nil, nil
			}
			return s.chunk(api.ChunkChoice{Delta: api.Delta{ReasoningContent: ev.Delta.ReasoningContent.Text}}), nil
		default:
			if ev.Delta.Text == "" {
				return nil, nil
			}
			return s.chunk(api.ChunkChoice{Delta: api.Delta{Content: ev.Delta.Text}}), nil
		}

	case "messageStop":
		return s.chunk(api.ChunkChoice{FinishReason: mapStopReason(ev.StopReason)}), nil

	case "metadata":
		if ev.Usage == nil {
			return nil, nil
		}
		c := s.chunk()
		c.Usage = usageToUnified(ev.Usage)
		return c, nil

	default: // contentBlockStop and future event types: nothing to surface
		return nil, nil
	}
}

func (s *streamState) chunk(choices ...api.ChunkChoice) *api.ChatChunk {
	return &api.ChatChunk{
		ID:      s.id,
		Object:  "chat.completion.chunk",
		Created: s.created,
		Model:   s.model,
		Choices: choices,
	}
}

// exceptionStatus maps Bedrock eventstream exception types (lowercased) onto
// the HTTP status the same failure carries outside a stream, so
// ErrorFromHTTP classifies them consistently.
var exceptionStatus = map[string]int{
	"throttlingexception":         429,
	"validationexception":         400,
	"accessdeniedexception":       403,
	"resourcenotfoundexception":   404,
	"serviceunavailableexception": 503,
	"modelnotreadyexception":      503,
	"modeltimeoutexception":       408,
	"internalserverexception":     500,
	"modelstreamerrorexception":   500,
}

// streamException converts an :message-type "exception"/"error" frame into a
// classified *api.Error.
func streamException(model string, msg *eventMessage) error {
	code := msg.headers[":exception-type"]
	if code == "" {
		code = msg.headers[":error-code"]
	}
	status, ok := exceptionStatus[strings.ToLower(code)]
	if !ok {
		status = 500
	}
	body := msg.payload
	if len(body) == 0 && msg.headers[":error-message"] != "" {
		body = []byte(msg.headers[":error-message"])
	}
	e := api.ErrorFromHTTP("bedrock", model, status, body, 0)
	if e.Code == "" {
		e.Code = code
	}
	return e
}
