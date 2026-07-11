package bedrock

// SageMaker lives in the bedrock package because it shares all the AWS
// plumbing — SigV4 signing, credential/region resolution, and the
// vnd.amazon.eventstream response framing. Only the endpoint and payload
// differ: the "model" is a SageMaker inference endpoint name, and the payload
// is an OpenAI chat/completions document (the "Messages API" served by
// LMI/TGI containers — litellm's sagemaker_chat). Classic sagemaker
// text-generation payloads ({"inputs": ...}) are model-specific and not
// supported.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

func init() {
	api.Register("sagemaker", func(cfg api.ProviderConfig) (api.Provider, error) {
		return &SageMaker{cfg: cfg}, nil
	})
	api.RegisterAlias("sagemaker_chat", "sagemaker")
}

// SageMaker is the Amazon SageMaker runtime adapter (Messages API).
type SageMaker struct {
	cfg api.ProviderConfig
}

func (p *SageMaker) Name() string { return "sagemaker" }

// endpoint builds the runtime invocation URL for an inference endpoint.
// action is "invocations" or "invocations-response-stream".
func (p *SageMaker) endpoint(override, region, endpointName, action string) (*url.URL, error) {
	base := p.cfg.BaseURL
	if override != "" {
		base = override
	}
	if base == "" {
		base = fmt.Sprintf("https://runtime.sagemaker.%s.amazonaws.com", region)
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "sagemaker", Message: fmt.Sprintf("invalid base URL: %v", err)}
	}
	escaped := url.PathEscape(endpointName)
	u.Path = strings.TrimRight(u.Path, "/") + "/endpoints/" + escaped + "/" + action
	u.RawPath = u.Path
	return u, nil
}

func (p *SageMaker) do(ctx context.Context, req *api.ChatRequest, action string, payload []byte) (*http.Response, error) {
	creds, err := resolveAWSCredentials(p.cfg, "sagemaker")
	if err != nil {
		return nil, err
	}
	u, err := p.endpoint(req.BaseURL, creds.region, req.Model, action)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, api.WrapTransport("sagemaker", req.Model, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	signRequest(httpReq, payload, creds, "sagemaker", time.Now())

	resp, err := p.cfg.Client().Do(httpReq)
	if err != nil {
		return nil, api.WrapTransport("sagemaker", req.Model, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return nil, api.ErrorFromHTTP("sagemaker", req.Model, resp.StatusCode, raw, retryAfter(resp))
	}
	return resp, nil
}

// payload marshals the wire body: the unified request IS the Messages API
// document. The model field carries the endpoint name, which containers
// ignore; stream is set per call.
func sagemakerPayload(req *api.ChatRequest, stream bool) ([]byte, error) {
	wire := *req
	wire.Stream = stream
	wire.StreamOptions = nil
	return json.Marshal(&wire)
}

func (p *SageMaker) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	payload, err := sagemakerPayload(req, false)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "sagemaker", Model: req.Model, Message: err.Error()}
	}
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	resp, err := p.do(ctx, req, "invocations", payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out api.ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, &api.Error{
			Type: api.ErrInternalServer, StatusCode: 502, Provider: "sagemaker",
			Model: req.Model, Message: fmt.Sprintf("malformed response: %v", err),
		}
	}
	out.Provider = "sagemaker"
	if out.Model == "" {
		out.Model = req.Model
	}
	return &out, nil
}

func (p *SageMaker) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	payload, err := sagemakerPayload(req, true)
	if err != nil {
		return nil, &api.Error{Type: api.ErrBadRequest, StatusCode: 400, Provider: "sagemaker", Model: req.Model, Message: err.Error()}
	}

	resp, err := p.do(ctx, req, "invocations-response-stream", payload)
	if err != nil {
		return nil, err
	}

	// The stream is eventstream frames whose payloads carry fragments of an
	// SSE-ish text stream ("data: {json}\n\n"), and one JSON document may be
	// split across frames — so fragments are accumulated until they parse
	// (litellm's decoder does the same).
	es := newEventStreamReader(resp.Body)
	var acc []byte
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			msg, err := es.next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport("sagemaker", req.Model, err)
			}
			fragment := bytes.TrimSpace(msg.payload)
			fragment = bytes.TrimPrefix(fragment, []byte("data:"))
			fragment = bytes.TrimSpace(fragment)
			if len(fragment) == 0 || bytes.Equal(fragment, []byte("[DONE]")) {
				continue
			}
			acc = append(acc, fragment...)

			var chunk api.ChatChunk
			if json.Unmarshal(acc, &chunk) != nil {
				continue // partial JSON; keep accumulating
			}
			acc = nil
			return &chunk, nil
		}
	}, resp.Body.Close), nil
}

func (p *SageMaker) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("sagemaker", "embeddings")
}
