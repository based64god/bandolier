// Package watsonx implements the IBM watsonx.ai adapter: /ml/v1/text/chat
// (and its _stream twin), whose request/response documents are OpenAI-shaped
// except that the model rides in `model_id` alongside a `project_id` (or
// `space_id`), and authentication is an IBM Cloud IAM bearer minted from an
// API key. Deployment models ("deployment/<id>") use the per-deployment chat
// endpoints and carry no model/project fields.
package watsonx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/based64god/gollm/api"
)

const (
	defaultIAMURL = "https://iam.cloud.ibm.com/identity/token"
	// defaultAPIVersion matches litellm's watsonx default.
	defaultAPIVersion = "2024-03-13"

	tokenExpirySkew = 60 * time.Second
)

func init() {
	api.Register("watsonx", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &Provider{cfg: cfg, auth: &authenticator{client: cfg.Client()}}, nil
	})
	api.RegisterAlias("watsonx_ai", "watsonx")
	api.RegisterAlias("watsonx_text", "watsonx")
}

// Provider is a watsonx.ai adapter instance.
type Provider struct {
	cfg  api.ProviderConfig
	auth *authenticator
}

func (p *Provider) Name() string { return "watsonx" }

func (p *Provider) extra(key string) string {
	if p.cfg.Extra == nil {
		return ""
	}
	return p.cfg.Extra[key]
}

// base resolves the watsonx service URL (e.g. https://us-south.ml.cloud.ibm.com).
func (p *Provider) base(override string) (string, error) {
	base := p.cfg.BaseURL
	if override != "" {
		base = override
	}
	if base == "" {
		for _, env := range []string{"WATSONX_URL", "WATSONX_API_BASE", "WX_URL"} {
			if v := os.Getenv(env); v != "" {
				base = v
				break
			}
		}
	}
	if base == "" {
		return "", &api.Error{
			Type: api.ErrBadRequest, StatusCode: 400, Provider: "watsonx",
			Message: "no watsonx endpoint: set WATSONX_URL (e.g. https://us-south.ml.cloud.ibm.com) or configure api_base",
		}
	}
	return strings.TrimRight(base, "/"), nil
}

// projectID resolves the watsonx.ai project (or "" when a space id or a
// deployment model makes it unnecessary).
func (p *Provider) projectID() string {
	if v := p.extra("project_id"); v != "" {
		return v
	}
	for _, env := range []string{"WATSONX_PROJECT_ID", "WX_PROJECT_ID", "PROJECT_ID"} {
		if v := os.Getenv(env); v != "" {
			return v
		}
	}
	return ""
}

func (p *Provider) spaceID() string {
	if v := p.extra("space_id"); v != "" {
		return v
	}
	for _, env := range []string{"WATSONX_SPACE_ID", "WX_SPACE_ID"} {
		if v := os.Getenv(env); v != "" {
			return v
		}
	}
	return ""
}

func apiVersion() string {
	if v := os.Getenv("WATSONX_API_VERSION"); v != "" {
		return v
	}
	return defaultAPIVersion
}

// chatURL builds the chat endpoint for a model: per-deployment for
// "deployment/<id>" models, else the project-level /ml/v1/text/chat.
func chatURL(base, model string, stream bool) string {
	suffix := "chat"
	if stream {
		suffix = "chat_stream"
	}
	var path string
	if id, ok := strings.CutPrefix(model, "deployment/"); ok {
		path = fmt.Sprintf("/ml/v1/deployments/%s/text/%s", url.PathEscape(id), suffix)
	} else {
		path = "/ml/v1/text/" + suffix
	}
	return base + path + "?version=" + url.QueryEscape(apiVersion())
}

// wireRequest renders the unified request as a watsonx chat document: the
// OpenAI fields minus `model`/`stream`, plus model_id + project_id/space_id
// (absent for deployment models).
func (p *Provider) wireRequest(req *api.ChatRequest) (map[string]json.RawMessage, error) {
	wire := *req
	wire.Stream = false
	wire.StreamOptions = nil
	raw, err := json.Marshal(&wire)
	if err != nil {
		return nil, err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	delete(doc, "model")
	delete(doc, "stream")

	if !strings.HasPrefix(req.Model, "deployment/") {
		doc["model_id"], _ = json.Marshal(req.Model)
		project, space := p.projectID(), p.spaceID()
		switch {
		case project != "":
			doc["project_id"], _ = json.Marshal(project)
		case space != "":
			doc["space_id"], _ = json.Marshal(space)
		default:
			return nil, &api.Error{
				Type: api.ErrBadRequest, StatusCode: 400, Provider: "watsonx",
				Message: "no watsonx project: set WATSONX_PROJECT_ID (or WATSONX_SPACE_ID)",
			}
		}
	}
	return doc, nil
}

func (p *Provider) do(ctx context.Context, req *api.ChatRequest, stream bool) (*http.Response, error) {
	base, err := p.base(req.BaseURL)
	if err != nil {
		return nil, err
	}
	doc, err := p.wireRequest(req)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(doc)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "watsonx", Message: err.Error()}
	}

	token, err := p.auth.bearer(ctx, req.APIKey)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, chatURL(base, req.Model, stream), bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("watsonx", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)
	if stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	} else {
		httpReq.Header.Set("Accept", "application/json")
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("watsonx", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("watsonx", req.Model, resp.StatusCode, raw, 0)
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

	// The response is OpenAI-shaped with model_id instead of model.
	var out struct {
		api.ChatResponse
		ModelID string `json:"model_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "watsonx",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	res := out.ChatResponse
	res.Provider = "watsonx"
	if res.Model == "" {
		res.Model = out.ModelID
	}
	if res.Model == "" {
		res.Model = req.Model
	}
	if res.Object == "" {
		res.Object = "chat.completion"
	}
	return &res, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	resp, err := p.do(ctx, req, true)
	if err != nil {
		return nil, err
	}

	sse := api.NewSSEReader(resp.Body)
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport("watsonx", req.Model, err)
			}
			if ev.IsDone() || len(ev.Data) == 0 {
				if ev.IsDone() {
					return nil, io.EOF
				}
				continue
			}
			var chunk struct {
				api.ChatChunk
				ModelID string `json:"model_id"`
			}
			if err := json.Unmarshal(ev.Data, &chunk); err != nil {
				return nil, &api.Error{
					Type: api.ErrInternalServer, StatusCode: 502, Provider: "watsonx",
					Model: req.Model, Message: fmt.Sprintf("malformed stream chunk: %v", err),
				}
			}
			out := chunk.ChatChunk
			if out.Model == "" {
				out.Model = chunk.ModelID
			}
			return &out, nil
		}
	}, resp.Body.Close), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("watsonx", "embeddings")
}

// ── IAM authentication ───────────────────────────────────────────────────────

// authenticator mints IBM Cloud IAM bearers from a watsonx API key, caching
// until expiry. A pre-minted bearer (WATSONX_TOKEN) short-circuits the
// exchange.
type authenticator struct {
	client *http.Client
	iamURL string // overridable for tests

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// bearer returns a valid IAM bearer token. keyOverride is a per-request API
// key (exchanged, not sent verbatim).
func (a *authenticator) bearer(ctx context.Context, keyOverride string) (string, error) {
	if v := os.Getenv("WATSONX_TOKEN"); v != "" && keyOverride == "" {
		return v, nil
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && time.Now().Before(a.expiresAt.Add(-tokenExpirySkew)) {
		return a.token, nil
	}

	apikey := keyOverride
	if apikey == "" {
		for _, env := range []string{"WATSONX_APIKEY", "WATSONX_API_KEY", "WX_API_KEY"} {
			if v := os.Getenv(env); v != "" {
				apikey = v
				break
			}
		}
	}
	if apikey == "" {
		return "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "watsonx",
			Message: "no watsonx credentials: set WATSONX_APIKEY (IBM Cloud API key) or WATSONX_TOKEN (pre-minted bearer)",
		}
	}

	iamURL := a.iamURL
	if iamURL == "" {
		iamURL = os.Getenv("WATSONX_IAM_URL")
	}
	if iamURL == "" {
		iamURL = defaultIAMURL
	}
	form := url.Values{
		"grant_type": {"urn:ibm:params:oauth:grant-type:apikey"},
		"apikey":     {apikey},
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, iamURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", api.WrapTransport("watsonx", "", err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := a.client.Do(httpReq)
	if err != nil {
		return "", api.WrapTransport("watsonx", "", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: resp.StatusCode, Provider: "watsonx",
			Message: fmt.Sprintf("IAM token exchange failed: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))),
		}
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return "", &api.Error{
			Type: api.ErrAuthentication, StatusCode: 401, Provider: "watsonx",
			Message: "IAM token exchange returned no access_token",
		}
	}
	a.token = out.AccessToken
	if out.ExpiresIn > 0 {
		a.expiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	} else {
		a.expiresAt = time.Now().Add(30 * time.Minute)
	}
	return a.token, nil
}
