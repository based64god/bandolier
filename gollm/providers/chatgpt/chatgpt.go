// Package chatgpt implements the ChatGPT-subscription adapter: the model
// family a ChatGPT plan serves through the Codex backend
// (chatgpt.com/backend-api/codex), authenticated with the OAuth tokens from
// `codex login` rather than a metered API key. The backend speaks
// chat/completions (litellm's chatgpt provider does the same), so this
// adapter wraps the openai adapter and only owns the credential dance, the
// extra headers, the parameters the backend rejects, and its stream quirks.
package chatgpt

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"runtime"

	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/providers/openai"
)

const apiBase = "https://chatgpt.com/backend-api/codex"

// defaultOriginator identifies the calling app to the backend; requests
// without a known originator are rejected. codex_cli_rs is the Codex CLI's
// value (and litellm's default).
const defaultOriginator = "codex_cli_rs"

func init() {
	api.Register("chatgpt", func(cfg api.ProviderConfig) (api.Provider, error) {
		if cfg.BaseURL == "" {
			cfg.BaseURL = apiBase
		}
		inner, err := openai.NewFactory(openai.Defaults{
			Name:    "chatgpt",
			BaseURL: apiBase,
			// The backend rejects stream_options; auth is OAuth, not an env key.
			StreamOptionsSupported: false,
			EmbeddingsSupported:    false,
		})(cfg)
		if err != nil {
			return nil, err
		}
		return &Provider{inner: inner, auth: newAuthenticator(cfg.Client())}, nil
	})
}

// Provider adapts the ChatGPT subscription backend.
type Provider struct {
	inner api.Provider
	auth  *authenticator
}

func (p *Provider) Name() string { return "chatgpt" }

// prepare clones the request with the OAuth bearer, the backend's required
// headers, and the parameters it rejects stripped. A caller-supplied APIKey
// is honored as a pre-minted access token.
func (p *Provider) prepare(ctx context.Context, req *api.ChatRequest) (*api.ChatRequest, error) {
	out := *req

	token := req.APIKey
	accountID := ""
	if token == "" {
		var err error
		token, accountID, err = p.auth.accessToken(ctx)
		if err != nil {
			return nil, err
		}
	} else {
		accountID = accountIDFromToken(token)
	}
	out.APIKey = token

	headers := make(map[string]string, len(req.Headers)+5)
	originator := os.Getenv("CHATGPT_ORIGINATOR")
	if originator == "" {
		originator = defaultOriginator
	}
	userAgent := os.Getenv("CHATGPT_USER_AGENT")
	if userAgent == "" {
		userAgent = fmt.Sprintf("%s/0.0.0 (%s %s) gollm", originator, runtime.GOOS, runtime.GOARCH)
	}
	headers["originator"] = originator
	headers["User-Agent"] = userAgent
	headers["Accept"] = "text/event-stream"
	headers["session_id"] = sessionID()
	if accountID != "" {
		headers["ChatGPT-Account-Id"] = accountID
	}
	for k, v := range req.Headers {
		headers[k] = v
	}
	out.Headers = headers

	// The subscription backend rejects token-limit fields; drop them rather
	// than failing the call (litellm strips the same set).
	out.MaxTokens = nil
	out.MaxCompletionTokens = nil
	return &out, nil
}

// Complete streams and folds: the backend is SSE-first (it answers even
// "non-streaming" calls as an event stream), so aggregating our own stream is
// the shape that works everywhere.
func (p *Provider) Complete(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	stream, err := p.Stream(ctx, req)
	if err != nil {
		return nil, err
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		acc.Add(chunk)
	}
	resp := acc.Response()
	resp.Provider = "chatgpt"
	if resp.Model == "" {
		resp.Model = req.Model
	}
	return resp, nil
}

func (p *Provider) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	wire, err := p.prepare(ctx, req)
	if err != nil {
		return nil, err
	}
	inner, err := p.inner.Stream(ctx, wire)
	if err != nil {
		return nil, err
	}
	return normalizeToolCalls(inner), nil
}

func (p *Provider) Embed(context.Context, *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	return nil, api.NotSupported("chatgpt", "embeddings")
}

// sessionID mints the per-request session_id header (a UUID-shaped random
// id; the backend only requires uniqueness).
func sessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

// ── stream normalization ─────────────────────────────────────────────────────

// normalizeToolCalls fixes the backend's non-spec streaming tool calls:
// `index` is always 0 even for parallel calls, and each call's id/name are
// repeated in a redundant "closing" chunk. Fragments are re-indexed by call
// id and the duplicate closers dropped, so downstream accumulators (which
// correlate by index, per the OpenAI spec) see a well-formed stream.
func normalizeToolCalls(inner api.ChatStream) api.ChatStream {
	seen := map[string]int{} // tool_call id → assigned index
	next := 0
	last := -1 // index of the call currently streaming argument fragments

	return api.StreamFunc(func() (*api.ChatChunk, error) {
		for {
			chunk, err := inner.Recv()
			if err != nil {
				return nil, err
			}
			if len(chunk.Choices) == 0 || len(chunk.Choices[0].Delta.ToolCalls) == 0 {
				return chunk, nil
			}

			delta := &chunk.Choices[0].Delta
			kept := delta.ToolCalls[:0]
			for _, tc := range delta.ToolCalls {
				switch {
				case tc.ID != "" && !hasKey(seen, tc.ID):
					// New call: assign the next spec-compliant index.
					idx := next
					next++
					seen[tc.ID] = idx
					last = idx
					tc.Index = &idx
					kept = append(kept, tc)
				case tc.ID != "":
					// Redundant closing chunk repeating id/name: drop it.
				default:
					// Continuation fragment: belongs to the call in flight.
					if last >= 0 {
						idx := last
						tc.Index = &idx
					}
					kept = append(kept, tc)
				}
			}
			if len(kept) == 0 {
				continue // chunk held only duplicates
			}
			delta.ToolCalls = kept
			return chunk, nil
		}
	}, inner.Close)
}

func hasKey(m map[string]int, k string) bool {
	_, ok := m[k]
	return ok
}
