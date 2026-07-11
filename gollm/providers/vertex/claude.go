package vertex

import (
	"context"
	"encoding/json"
	"io"

	"github.com/based64god/gollm/anthropic"
	"github.com/based64god/gollm/api"
)

// claudeBody encodes a Messages API request for Vertex: the model moves to
// the URL and anthropic_version replaces it in the body. Null-valued fields
// (an unset system prompt) are dropped rather than sent as JSON null.
func claudeBody(mreq *anthropic.MessagesRequest) ([]byte, error) {
	raw, err := json.Marshal(mreq)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	for k, v := range m {
		if v == nil {
			delete(m, k)
		}
	}
	delete(m, "model")
	m["anthropic_version"] = anthropicVersion
	return json.Marshal(m)
}

func (p *Provider) claudeComplete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	mreq, err := anthropic.RequestFromUnified(req)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	mreq.Stream = false
	payload, err := claudeBody(mreq)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	url, err := p.modelURL(req.BaseURL, "anthropic", req.Model, "rawPredict")
	if err != nil {
		return nil, err
	}

	resp, err := p.do(ctx, url, req.Model, req.APIKey, req.Headers, payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var mresp anthropic.MessagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&mresp); err != nil {
		return nil, malformed(req.Model, err)
	}
	out := anthropic.ResponseToUnified(&mresp)
	out.Provider = providerName
	if out.Model == "" {
		out.Model = req.Model
	}
	return out, nil
}

func (p *Provider) claudeStream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	mreq, err := anthropic.RequestFromUnified(req)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	mreq.Stream = true
	payload, err := claudeBody(mreq)
	if err != nil {
		return nil, badRequest(req.Model, err)
	}
	url, err := p.modelURL(req.BaseURL, "anthropic", req.Model, "streamRawPredict")
	if err != nil {
		return nil, err
	}

	resp, err := p.do(ctx, url, req.Model, req.APIKey, req.Headers, payload)
	if err != nil {
		return nil, err
	}

	// streamRawPredict relays the Messages API SSE stream unchanged.
	sse := api.NewSSEReader(resp.Body)
	dec := anthropic.NewDecodeState()
	done := false
	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			if done {
				return nil, io.EOF
			}
			ev, err := sse.Next()
			if err != nil {
				if err == io.EOF {
					return nil, io.EOF
				}
				return nil, api.WrapTransport(providerName, req.Model, err)
			}
			var sev anthropic.StreamEvent
			if err := json.Unmarshal(ev.Data, &sev); err != nil {
				return nil, malformed(req.Model, err)
			}
			if sev.Type == "message_stop" {
				done = true
				return nil, io.EOF
			}
			chunk, err := dec.Event(&sev)
			if err != nil {
				// The shared decoder attributes stream errors to "anthropic";
				// re-attribute to this provider so router cooldowns and logs
				// blame the deployment that actually failed.
				if apiErr, ok := api.AsError(err); ok {
					apiErr.Provider = providerName
					if apiErr.Model == "" {
						apiErr.Model = req.Model
					}
				}
				return nil, err
			}
			if chunk != nil {
				return chunk, nil
			}
		}
	}, resp.Body.Close), nil
}
