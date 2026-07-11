package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

// ErrorType classifies failures the way litellm's exception taxonomy (itself
// modeled on OpenAI's error types) does, so callers can branch on semantics
// rather than provider-specific status codes.
type ErrorType string

const (
	ErrAuthentication ErrorType = "authentication_error"
	ErrPermission     ErrorType = "permission_error"
	ErrNotFound       ErrorType = "not_found_error"
	ErrBadRequest     ErrorType = "invalid_request_error"
	ErrUnprocessable  ErrorType = "unprocessable_entity"
	ErrRateLimit      ErrorType = "rate_limit_error"
	ErrTimeout        ErrorType = "timeout_error"
	ErrContextWindow  ErrorType = "context_window_exceeded"
	ErrContentPolicy  ErrorType = "content_policy_violation"
	ErrAPIConnection  ErrorType = "api_connection_error"
	ErrInternalServer ErrorType = "internal_server_error"
	ErrUnavailable    ErrorType = "service_unavailable_error"
	ErrNotSupported   ErrorType = "not_supported_error"
)

// Error is gollm's provider-agnostic API error.
type Error struct {
	Type       ErrorType
	StatusCode int
	Message    string
	// Code and Param are OpenAI's fine-grained error fields when present.
	Code  string
	Param string
	// Provider and Model attribute the failure for logs and router decisions.
	Provider string
	Model    string
	// RetryAfter is the provider's requested backoff, when it sent one.
	RetryAfter time.Duration
	// Raw preserves the provider's original error body.
	Raw json.RawMessage
}

func (e *Error) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s", e.Type)
	if e.Provider != "" {
		fmt.Fprintf(&b, " (provider=%s", e.Provider)
		if e.Model != "" {
			fmt.Fprintf(&b, ", model=%s", e.Model)
		}
		b.WriteString(")")
	}
	if e.StatusCode != 0 {
		fmt.Fprintf(&b, " status=%d", e.StatusCode)
	}
	if e.Message != "" {
		fmt.Fprintf(&b, ": %s", e.Message)
	}
	return b.String()
}

// Retryable reports whether retrying the same deployment could plausibly
// succeed: rate limits, timeouts, connection failures, and 5xx.
func (e *Error) Retryable() bool {
	switch e.Type {
	case ErrRateLimit, ErrTimeout, ErrAPIConnection, ErrInternalServer, ErrUnavailable:
		return true
	}
	return false
}

// NotSupported builds the error providers return for operations they don't
// implement (e.g. embeddings on a chat-only provider).
func NotSupported(provider, op string) *Error {
	return &Error{
		Type:       ErrNotSupported,
		StatusCode: 400,
		Provider:   provider,
		Message:    fmt.Sprintf("%s does not support %s", provider, op),
	}
}

// AsError extracts a *Error from any error chain.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// contextWindowPatterns identify context-overflow failures, which providers
// report as generic 400s with a telltale message. Router fallback treats these
// specially (retrying the same deployment can never succeed; a longer-context
// fallback can). Mirrors litellm's ContextWindowExceededError sniffing.
var contextWindowPatterns = []string{
	"context length",
	"context window",
	"maximum context",
	"context_length_exceeded",
	"prompt is too long",
	"input is too long",
	"too many tokens",
	"exceeds the maximum number of tokens",
	"input length and `max_tokens` exceed context limit",
}

// contentPolicyPatterns identify content-filter rejections inside generic 400s.
var contentPolicyPatterns = []string{
	"content management policy",
	"content policy",
	"content_filter",
	"safety",
	"flagged as potentially violating",
}

// ErrorFromHTTP converts a provider's non-2xx response into a classified
// *Error. It understands both OpenAI's {"error": {...}} and Anthropic's
// {"type":"error","error":{...}} envelopes and falls back to the raw body.
func ErrorFromHTTP(provider, model string, status int, body []byte, retryAfter time.Duration) *Error {
	e := &Error{
		StatusCode: status,
		Provider:   provider,
		Model:      model,
		RetryAfter: retryAfter,
		Raw:        json.RawMessage(body),
	}

	// OpenAI shape and Anthropic shape both nest under "error"; Anthropic's
	// inner "type" is its own taxonomy ("overloaded_error", ...), captured as
	// Code, with classification driven by the HTTP status.
	var envelope struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Param   string `json:"param"`
			Code    any    `json:"code"`
		} `json:"error"`
		// Some providers (gemini) use {"error": {"message", "status"}}; others
		// put a bare "message" at top level.
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil {
		switch {
		case envelope.Error.Message != "":
			e.Message = envelope.Error.Message
			e.Param = envelope.Error.Param
			if envelope.Error.Code != nil {
				e.Code = fmt.Sprintf("%v", envelope.Error.Code)
			} else {
				e.Code = envelope.Error.Type
			}
		case envelope.Message != "":
			e.Message = envelope.Message
		}
	}
	if e.Message == "" {
		e.Message = strings.TrimSpace(string(body))
		if e.Message == "" {
			e.Message = fmt.Sprintf("HTTP %d with empty body", status)
		}
	}

	e.Type = classifyStatus(status, e.Message)
	return e
}

func classifyStatus(status int, message string) ErrorType {
	lower := strings.ToLower(message)
	switch status {
	case 400:
		for _, p := range contextWindowPatterns {
			if strings.Contains(lower, p) {
				return ErrContextWindow
			}
		}
		for _, p := range contentPolicyPatterns {
			if strings.Contains(lower, p) {
				return ErrContentPolicy
			}
		}
		return ErrBadRequest
	case 401:
		return ErrAuthentication
	case 403:
		return ErrPermission
	case 404:
		return ErrNotFound
	case 408:
		return ErrTimeout
	case 413:
		return ErrContextWindow
	case 422:
		return ErrUnprocessable
	case 429:
		return ErrRateLimit
	case 500, 502:
		return ErrInternalServer
	case 503, 529:
		return ErrUnavailable
	default:
		if status >= 500 {
			return ErrInternalServer
		}
		return ErrBadRequest
	}
}

// WrapTransport converts transport-level failures (DNS, refused connections,
// deadline exceeded) into classified errors so the router can treat them like
// any other retryable failure. A nil err returns nil; an existing *Error
// passes through unchanged.
func WrapTransport(provider, model string, err error) error {
	if err == nil {
		return nil
	}
	if _, ok := AsError(err); ok {
		return err
	}
	e := &Error{Provider: provider, Model: model, Message: err.Error()}
	var netErr net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		e.Type = ErrTimeout
		e.StatusCode = 408
	case errors.As(err, &netErr) && netErr.Timeout():
		e.Type = ErrTimeout
		e.StatusCode = 408
	case errors.Is(err, context.Canceled):
		// Cancellation is the caller's own signal — not a provider fault, and
		// never retryable.
		e.Type = ErrAPIConnection
		e.StatusCode = 499
		return e
	default:
		e.Type = ErrAPIConnection
		e.StatusCode = 500
	}
	return e
}
