package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/based64god/gollm/anthropic"
	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/providers/anthropicp"
	"github.com/based64god/gollm/tokens"
)

// handleMessages serves POST /v1/messages — the Anthropic Messages API
// surface. This is the endpoint Claude Code hits when ANTHROPIC_BASE_URL
// points at the proxy: requests arrive in Anthropic wire format, get routed
// to whatever backend the requested model alias maps to, and responses go
// back in Anthropic wire format (streaming as Messages API SSE events).
func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "failed to read body: "+err.Error())
		return
	}
	var mreq anthropic.MessagesRequest
	if err := json.Unmarshal(body, &mreq); err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "malformed JSON: "+err.Error())
		return
	}
	if mreq.Model == "" {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "model is required")
		return
	}

	vk, aerr := s.authenticate(r, mreq.Model)
	if aerr != nil {
		writeAnthropicError(w, aerr.status, anthropicAuthErrType(aerr.status), aerr.message)
		return
	}

	if !s.router.HasModel(mreq.Model) {
		writeAnthropicError(w, http.StatusNotFound, "not_found_error",
			"model \""+mreq.Model+"\" is not configured; known models: "+strings.Join(s.router.ModelNames(), ", "))
		return
	}

	entry := SpendEntry{
		Timestamp:  start,
		KeyAlias:   keyAlias(vk),
		ModelAlias: mreq.Model,
		Endpoint:   "messages",
		Stream:     mreq.Stream,
	}

	// Anthropic-format client + anthropic backend: forward the original body
	// verbatim (with the model swapped) so cache_control and thinking
	// signatures survive.
	if s.passthroughEligible(mreq.Model) {
		s.messagesPassthrough(w, r, body, &mreq, entry, vk, start)
		return
	}

	// Translated path: Anthropic → unified → any backend → Anthropic. The name
	// map restores tool names that were shortened to satisfy OpenAI's 64-char
	// function-name limit, so the client sees the names it sent.
	req, nameMap, err := anthropic.RequestToUnifiedWithTools(&mreq)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	req.Model = mreq.Model // router routes by alias

	if mreq.Stream {
		s.messagesStream(w, r, req, &mreq, nameMap, entry, vk, start)
		return
	}

	resp, err := s.router.Completion(r.Context(), req)
	if err != nil {
		entry.Status, entry.Error = errorStatus(err), err.Error()
		entry.Duration = time.Since(start)
		s.record(entry, vk)
		status, envelope := anthropic.ErrorBody(err)
		writeJSON(w, status, envelope)
		return
	}

	mresp := anthropic.ResponseFromUnifiedNamed(resp, nameMap)
	mresp.Model = mreq.Model // echo the alias the client asked for
	entry.Status = http.StatusOK
	entry.Duration = time.Since(start)
	if resp.Usage != nil {
		entry.PromptTokens = resp.Usage.PromptTokens
		entry.CompletionTokens = resp.Usage.CompletionTokens
		entry.Cost = s.usageCost(mreq.Model, resp.Usage)
	}
	s.record(entry, vk)
	writeJSON(w, http.StatusOK, mresp)
}

// messagesStream runs the translated streaming path: unified chunks from the
// router are re-encoded as Messages API SSE events on the fly.
func (s *Server) messagesStream(w http.ResponseWriter, r *http.Request, req *api.ChatRequest, mreq *anthropic.MessagesRequest, nameMap map[string]string, entry SpendEntry, vk *VirtualKey, start time.Time) {
	stream, err := s.router.Stream(r.Context(), req)
	if err != nil {
		entry.Status, entry.Error = errorStatus(err), err.Error()
		entry.Duration = time.Since(start)
		s.record(entry, vk)
		status, envelope := anthropic.ErrorBody(err)
		writeJSON(w, status, envelope)
		return
	}
	defer stream.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	writeEvents := func(events []anthropic.Event) {
		for _, ev := range events {
			_, _ = w.Write(ev.FormatSSE())
		}
		if flusher != nil && len(events) > 0 {
			flusher.Flush()
		}
	}

	enc := anthropic.NewEncodeStateWithNames(mreq.Model, nameMap)
	var usage *api.Usage
	var completionChars int
	for {
		chunk, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				writeEvents(enc.Finish())
				entry.Status = http.StatusOK
			} else {
				// Mid-stream failure: report in-band (headers are long gone).
				writeEvents(enc.FinishError(err))
				entry.Status, entry.Error = errorStatus(err), err.Error()
			}
			break
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
		for _, c := range chunk.Choices {
			completionChars += len(c.Delta.Content)
		}
		writeEvents(enc.Chunk(chunk))
	}

	entry.Duration = time.Since(start)
	s.recordStreamUsage(&entry, usage, completionChars)
	s.finalizeCost(&entry)
	s.record(entry, vk)
}

// messagesPassthrough forwards the raw request to an anthropic-provider
// deployment, streaming the raw response back. The deployment is chosen
// through the router (SelectDeployment), so passthrough still gets load
// balancing, cooldowns, and RPM/TPM limits — it just can't be re-routed
// mid-stream once bytes flow, so there is one attempt and no fallback. Usage
// is sniffed from the response for spend accounting without altering the wire
// bytes.
func (s *Server) messagesPassthrough(w http.ResponseWriter, r *http.Request, body []byte, mreq *anthropic.MessagesRequest, entry SpendEntry, vk *VirtualKey, start time.Time) {
	prov, err := s.client.Provider("anthropic")
	if err != nil {
		writeAnthropicError(w, http.StatusInternalServerError, "api_error", err.Error())
		return
	}
	ap, ok := prov.(*anthropicp.Provider)
	if !ok {
		writeAnthropicError(w, http.StatusInternalServerError, "api_error", "anthropic provider unavailable")
		return
	}

	dep, release, err := s.router.SelectDeployment(mreq.Model)
	if err != nil {
		entry.Status, entry.Error = errorStatus(err), err.Error()
		entry.Duration = time.Since(start)
		s.record(entry, vk)
		status, envelope := anthropic.ErrorBody(err)
		writeJSON(w, status, envelope)
		return
	}
	// released tracks the router settlement so it fires exactly once with the
	// final usage (release itself is idempotent, but usage is only known late).
	var settleUsage *api.Usage
	settled := false
	settle := func(ok bool) {
		if settled {
			return
		}
		settled = true
		release(ok, settleUsage)
	}
	defer settle(false) // fail-safe if we return before an explicit settle

	// Swap the alias for the deployment's real model (wildcard already
	// substituted by SelectDeployment), preserving every other byte.
	patched, err := swapJSONField(body, "model", providerLocalModel(dep.Params.Model))
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}

	headers := map[string]string{}
	for k, v := range dep.Params.Headers {
		headers[k] = v
	}
	// Forward beta opt-ins (prompt caching variants, token-efficient tools).
	if beta := r.Header.Get("anthropic-beta"); beta != "" {
		headers["anthropic-beta"] = beta
	}

	ctx := r.Context()
	resp, err := ap.RawMessages(ctx, patched, dep.Params.Model, dep.Params.APIKey, dep.Params.BaseURL, headers)
	if err != nil {
		entry.Status, entry.Error = errorStatus(err), err.Error()
		entry.Duration = time.Since(start)
		s.record(entry, vk)
		settle(false)
		status, envelope := anthropic.ErrorBody(err)
		writeJSON(w, status, envelope)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	entry.Status = resp.StatusCode

	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		usage := copySSESniffingUsage(w, resp.Body)
		if usage != nil {
			settleUsage = anthropic.UsageToUnified(usage)
			entry.PromptTokens = usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
			entry.CompletionTokens = usage.OutputTokens
			entry.Cost = s.usageCost(mreq.Model, settleUsage)
		}
	} else {
		buf, _ := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
		_, _ = w.Write(buf)
		var mresp anthropic.MessagesResponse
		if json.Unmarshal(buf, &mresp) == nil && mresp.Usage != nil {
			settleUsage = anthropic.UsageToUnified(mresp.Usage)
			entry.PromptTokens = mresp.Usage.InputTokens + mresp.Usage.CacheReadInputTokens + mresp.Usage.CacheCreationInputTokens
			entry.CompletionTokens = mresp.Usage.OutputTokens
			entry.Cost = s.usageCost(mreq.Model, settleUsage)
		}
	}
	entry.Duration = time.Since(start)
	s.record(entry, vk)
	settle(resp.StatusCode < 400)
}

// copySSESniffingUsage pipes an SSE body through to the client unchanged
// while accumulating usage from message_start and message_delta events.
func copySSESniffingUsage(w http.ResponseWriter, body io.Reader) *anthropic.Usage {
	flusher, _ := w.(http.Flusher)
	scanner := bufio.NewReader(body)
	total := &anthropic.Usage{}
	saw := false
	for {
		line, err := scanner.ReadBytes('\n')
		if len(line) > 0 {
			_, _ = w.Write(line)
			// Events end on blank lines; flushing per line keeps latency low
			// and code simple.
			if flusher != nil {
				flusher.Flush()
			}
			if data, ok := bytes.CutPrefix(bytes.TrimRight(line, "\r\n"), []byte("data: ")); ok {
				var ev anthropic.StreamEvent
				if json.Unmarshal(data, &ev) == nil {
					switch {
					case ev.Type == "message_start" && ev.Message != nil && ev.Message.Usage != nil:
						*total = *ev.Message.Usage
						saw = true
					case ev.Type == "message_delta" && ev.Usage != nil:
						total.OutputTokens = ev.Usage.OutputTokens
						saw = true
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	if !saw {
		return nil
	}
	return total
}

// handleCountTokens serves POST /v1/messages/count_tokens. Anthropic-backed
// aliases forward to the real endpoint; anything else gets the heuristic
// estimate (documented as approximate).
func (s *Server) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	var creq anthropic.CountTokensRequest
	if err := json.Unmarshal(body, &creq); err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "malformed JSON: "+err.Error())
		return
	}
	if _, aerr := s.authenticate(r, creq.Model); aerr != nil {
		writeAnthropicError(w, aerr.status, anthropicAuthErrType(aerr.status), aerr.message)
		return
	}

	if s.passthroughEligible(creq.Model) {
		// Resolve a backend deployment (wildcard-substituted) to forward the
		// count to its real Anthropic endpoint. release(true) immediately: a
		// token count neither generates nor should skew load state.
		if dep, release, derr := s.router.SelectDeployment(creq.Model); derr == nil {
			release(true, nil)
			if prov, err := s.client.Provider("anthropic"); err == nil {
				if ap, ok := prov.(*anthropicp.Provider); ok {
					patched, perr := swapJSONField(body, "model", providerLocalModel(dep.Params.Model))
					if perr == nil {
						if out, cerr := ap.CountTokens(r.Context(), patched, dep.Params.Model, dep.Params.APIKey, dep.Params.BaseURL); cerr == nil {
							writeJSON(w, http.StatusOK, out)
							return
						}
					}
				}
			}
		}
		// Forwarding failed — fall through to the estimate rather than erroring
		// a best-effort endpoint.
	}

	count := tokens.EstimateAnthropicMessages(creq.System.JoinedText(), creq.Messages, creq.Tools)
	writeJSON(w, http.StatusOK, anthropic.CountTokensResponse{InputTokens: count})
}

// swapJSONField replaces one top-level field in a JSON object without
// disturbing any other bytes' semantics.
func swapJSONField(body []byte, field, value string) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	enc, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	m[field] = enc
	return json.Marshal(m)
}

// anthropicAuthErrType maps an auth failure status onto Anthropic's error
// type strings.
func anthropicAuthErrType(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return "authentication_error"
	case http.StatusForbidden:
		return "permission_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	default:
		return "invalid_request_error"
	}
}

func writeAnthropicError(w http.ResponseWriter, status int, typ, msg string) {
	writeJSON(w, status, anthropic.ErrorResponse{
		Type:  "error",
		Error: anthropic.ErrorDetail{Type: typ, Message: msg},
	})
}

// errorStatus extracts an HTTP status from a (possibly classified) error.
func errorStatus(err error) int {
	if apiErr, ok := api.AsError(err); ok && apiErr.StatusCode != 0 {
		return apiErr.StatusCode
	}
	return http.StatusInternalServerError
}
