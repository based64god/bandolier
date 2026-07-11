package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
	"github.com/based64god/gollm/costs"
)

// modeledChatFields are the OpenAI chat-completion JSON keys api.ChatRequest
// models directly. Any other top-level key in a request body is preserved into
// req.Extra so provider-specific params (store, metadata, prediction,
// modalities, audio, service_tier, web_search_options, …) reach the backend
// rather than being silently dropped by struct decoding.
var modeledChatFields = map[string]bool{
	"model": true, "messages": true, "temperature": true, "top_p": true,
	"n": true, "stop": true, "max_tokens": true, "max_completion_tokens": true,
	"presence_penalty": true, "frequency_penalty": true, "logit_bias": true,
	"user": true, "seed": true, "logprobs": true, "top_logprobs": true,
	"tools": true, "tool_choice": true, "parallel_tool_calls": true,
	"response_format": true, "reasoning_effort": true, "stream": true,
	"stream_options": true,
}

// decodeChatRequest decodes a chat body into a ChatRequest, folding any
// unmodeled top-level keys into req.Extra so they pass through to the backend.
func decodeChatRequest(body []byte, req *api.ChatRequest) error {
	if err := json.Unmarshal(body, req); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return err
	}
	for k, v := range raw {
		if modeledChatFields[k] {
			continue
		}
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			continue
		}
		if req.Extra == nil {
			req.Extra = map[string]any{}
		}
		req.Extra[k] = val
	}
	return nil
}

// usageCost prices usage against the deployment that actually served it,
// falling back to the alias. The deployment model is what the backend bills,
// so it must win: the headline config maps Claude-named aliases onto
// non-Claude backends, where pricing the alias ("claude-sonnet-4-5") instead
// of the real model ("openai/gpt-5.2") would record the wrong USD cost and
// burn virtual-key budgets at the wrong rate. Pricing the alias is only a
// fallback for aliases that are themselves real, priceable model ids with no
// matching deployment entry (e.g. a wildcard).
func (s *Server) usageCost(alias string, usage *api.Usage) float64 {
	for _, e := range s.aliasEntries[alias] {
		if c := costs.Cost(e.Params.Model, usage); c > 0 {
			return c
		}
	}
	return costs.Cost(alias, usage)
}

// handleChatCompletions serves the OpenAI surface: POST /v1/chat/completions.
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "failed to read body: "+err.Error())
		return
	}
	var req api.ChatRequest
	if err := decodeChatRequest(body, &req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "malformed JSON body: "+err.Error())
		return
	}
	if req.Model == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model is required")
		return
	}
	vk, aerr := s.authenticate(r, req.Model)
	if aerr != nil {
		writeOpenAIError(w, aerr.status, aerr.message)
		return
	}
	if !s.router.HasModel(req.Model) {
		writeOpenAIError(w, http.StatusNotFound, "model \""+req.Model+"\" is not configured")
		return
	}
	// Client-supplied credentials must not ride through to backends; the
	// proxy's deployment credentials are authoritative. Extra may not smuggle
	// them either.
	req.APIKey, req.BaseURL, req.Headers = "", "", nil
	delete(req.Extra, "api_key")
	delete(req.Extra, "base_url")

	// Whether the client actually asked for a usage chunk; the provider forces
	// include_usage for accounting, so a client that didn't request it must not
	// see the extra usage-only chunk (OpenAI wire parity — see chatStream).
	clientWantsUsage := req.StreamOptions != nil && req.StreamOptions.IncludeUsage

	entry := SpendEntry{
		Timestamp:  start,
		KeyAlias:   keyAlias(vk),
		ModelAlias: req.Model,
		Endpoint:   "chat",
		Stream:     req.Stream,
	}

	if req.Stream {
		s.chatStream(w, r, &req, entry, vk, start, clientWantsUsage)
		return
	}

	resp, err := s.router.Completion(r.Context(), &req)
	if err != nil {
		entry.Status, entry.Error = errorStatus(err), err.Error()
		entry.Duration = time.Since(start)
		s.record(entry, vk)
		writeOpenAIErrorFrom(w, err)
		return
	}
	entry.Status = http.StatusOK
	entry.Duration = time.Since(start)
	if resp.Usage != nil {
		entry.PromptTokens = resp.Usage.PromptTokens
		entry.CompletionTokens = resp.Usage.CompletionTokens
		entry.Cost = s.usageCost(entry.ModelAlias, resp.Usage)
	}
	s.record(entry, vk)
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) chatStream(w http.ResponseWriter, r *http.Request, req *api.ChatRequest, entry SpendEntry, vk *VirtualKey, start time.Time, clientWantsUsage bool) {
	stream, err := s.router.Stream(r.Context(), req)
	if err != nil {
		entry.Status, entry.Error = errorStatus(err), err.Error()
		entry.Duration = time.Since(start)
		s.record(entry, vk)
		writeOpenAIErrorFrom(w, err)
		return
	}
	defer stream.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, _ := w.(http.Flusher)

	var usage *api.Usage
	var completionChars int // fallback token estimate if usage never arrives
	for {
		chunk, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				_, _ = io.WriteString(w, "data: [DONE]\n\n")
				entry.Status = http.StatusOK
			} else {
				// In-band error object, then terminate (OpenAI's own pattern).
				payload, _ := json.Marshal(openAIErrorEnvelope(err))
				_, _ = io.WriteString(w, "data: "+string(payload)+"\n\n")
				entry.Status, entry.Error = errorStatus(err), err.Error()
			}
			if flusher != nil {
				flusher.Flush()
			}
			break
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
		for _, c := range chunk.Choices {
			completionChars += len(c.Delta.Content)
		}
		// The provider forces stream_options.include_usage for accounting; a
		// client that didn't ask for it must not receive the usage-only final
		// chunk (choices:[]) — suppress it here while still capturing usage.
		if !clientWantsUsage && len(chunk.Choices) == 0 && chunk.Usage != nil {
			continue
		}
		payload, _ := json.Marshal(chunk)
		_, _ = io.WriteString(w, "data: "+string(payload)+"\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}

	entry.Duration = time.Since(start)
	s.recordStreamUsage(&entry, usage, completionChars)
	s.finalizeCost(&entry)
	s.record(entry, vk)
}

// recordStreamUsage fills token counts from the backend's reported usage, or
// falls back to a heuristic completion-token estimate when the stream ended
// (client disconnect, or a backend that never sent a usage chunk) before usage
// arrived — so a mid-stream drop still records non-zero spend instead of $0.
func (s *Server) recordStreamUsage(entry *SpendEntry, usage *api.Usage, completionChars int) {
	if usage != nil {
		entry.PromptTokens = usage.PromptTokens
		entry.CompletionTokens = usage.CompletionTokens
		return
	}
	if completionChars > 0 {
		// ~4 chars/token, matching the tokens package heuristic.
		entry.CompletionTokens = (completionChars + 3) / 4
		entry.Error = strings.TrimSpace(entry.Error + " (usage estimated: stream ended before usage report)")
	}
}

// finalizeCost prices the recorded token counts against the alias/deployment.
func (s *Server) finalizeCost(entry *SpendEntry) {
	if entry.PromptTokens == 0 && entry.CompletionTokens == 0 {
		return
	}
	entry.Cost = s.usageCost(entry.ModelAlias, &api.Usage{
		PromptTokens:     entry.PromptTokens,
		CompletionTokens: entry.CompletionTokens,
	})
}

// handleEmbeddings serves POST /v1/embeddings.
func (s *Server) handleEmbeddings(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	var req api.EmbeddingRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "malformed JSON body: "+err.Error())
		return
	}
	if req.Model == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model is required")
		return
	}
	vk, aerr := s.authenticate(r, req.Model)
	if aerr != nil {
		writeOpenAIError(w, aerr.status, aerr.message)
		return
	}
	if !s.router.HasModel(req.Model) {
		writeOpenAIError(w, http.StatusNotFound, "model \""+req.Model+"\" is not configured")
		return
	}
	req.APIKey, req.BaseURL, req.Headers = "", "", nil

	entry := SpendEntry{
		Timestamp:  start,
		KeyAlias:   keyAlias(vk),
		ModelAlias: req.Model,
		Endpoint:   "embeddings",
	}

	resp, err := s.router.Embedding(r.Context(), &req)
	if err != nil {
		entry.Status, entry.Error = errorStatus(err), err.Error()
		entry.Duration = time.Since(start)
		s.record(entry, vk)
		writeOpenAIErrorFrom(w, err)
		return
	}
	entry.Status = http.StatusOK
	entry.Duration = time.Since(start)
	if resp.Usage != nil {
		entry.PromptTokens = resp.Usage.PromptTokens
		entry.Cost = s.usageCost(entry.ModelAlias, resp.Usage)
	}
	s.record(entry, vk)
	writeJSON(w, http.StatusOK, resp)
}

// ── OpenAI-format error rendering ───────────────────────────────────────────

type openAIError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code,omitempty"`
	Param   string `json:"param,omitempty"`
}

func openAIErrorEnvelope(err error) map[string]openAIError {
	oe := openAIError{Message: err.Error(), Type: "api_error"}
	if apiErr, ok := api.AsError(err); ok {
		oe.Message = apiErr.Message
		oe.Type = string(apiErr.Type)
		oe.Code = apiErr.Code
		oe.Param = apiErr.Param
	}
	return map[string]openAIError{"error": oe}
}

func writeOpenAIErrorFrom(w http.ResponseWriter, err error) {
	writeJSON(w, errorStatus(err), openAIErrorEnvelope(err))
}

func writeOpenAIError(w http.ResponseWriter, status int, msg string) {
	typ := "invalid_request_error"
	switch status {
	case http.StatusUnauthorized:
		typ = "authentication_error"
	case http.StatusForbidden:
		typ = "permission_error"
	case http.StatusNotFound:
		typ = "not_found_error"
	case http.StatusTooManyRequests:
		typ = "rate_limit_error"
	}
	writeJSON(w, status, map[string]openAIError{"error": {Message: msg, Type: typ}})
}
