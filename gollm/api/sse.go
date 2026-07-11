package api

import (
	"bufio"
	"bytes"
	"io"
	"strings"
)

// SSEEvent is one server-sent event: an optional event name and the joined
// data payload.
type SSEEvent struct {
	Name string
	Data []byte
}

// SSEReader incrementally parses a text/event-stream body. It handles
// multi-line data fields, comment lines, CRLF endings, and arbitrarily long
// lines (providers stream large tool-call argument fragments).
type SSEReader struct {
	r *bufio.Reader
}

func NewSSEReader(r io.Reader) *SSEReader {
	return &SSEReader{r: bufio.NewReaderSize(r, 64<<10)}
}

// Next returns the next complete event, or io.EOF when the stream ends. An
// event with no data lines at stream end is not surfaced.
func (s *SSEReader) Next() (*SSEEvent, error) {
	var (
		name     string
		data     [][]byte
		sawField bool
	)
	for {
		line, err := s.readLine()
		if err != nil {
			if err == io.EOF && sawField && len(data) > 0 {
				// Stream ended mid-event; deliver what we have (some providers
				// omit the final blank line).
				return &SSEEvent{Name: name, Data: bytes.Join(data, []byte("\n"))}, nil
			}
			return nil, err
		}

		if len(line) == 0 {
			// Blank line dispatches the pending event, if any.
			if sawField && len(data) > 0 {
				return &SSEEvent{Name: name, Data: bytes.Join(data, []byte("\n"))}, nil
			}
			name, data, sawField = "", nil, false
			continue
		}
		if line[0] == ':' { // comment / keep-alive
			continue
		}

		field, value := splitField(line)
		switch field {
		case "event":
			name = string(value)
			sawField = true
		case "data":
			data = append(data, value)
			sawField = true
		// id and retry are irrelevant to LLM streams; ignore.
		default:
		}
	}
}

// readLine reads one line without a length limit, stripping the trailing
// newline and optional carriage return.
func (s *SSEReader) readLine() ([]byte, error) {
	var full []byte
	for {
		part, err := s.r.ReadBytes('\n')
		full = append(full, part...)
		if err != nil {
			if err == io.EOF && len(full) > 0 {
				return trimEOL(full), nil
			}
			return nil, err
		}
		return trimEOL(full), nil
	}
}

func trimEOL(b []byte) []byte {
	b = bytes.TrimSuffix(b, []byte("\n"))
	b = bytes.TrimSuffix(b, []byte("\r"))
	return b
}

func splitField(line []byte) (field string, value []byte) {
	idx := bytes.IndexByte(line, ':')
	if idx < 0 {
		return string(line), nil
	}
	field = string(line[:idx])
	value = line[idx+1:]
	// Per spec, a single leading space in the value is stripped.
	value = bytes.TrimPrefix(value, []byte(" "))
	return field, value
}

// IsDone reports the OpenAI-style terminal sentinel.
func (e *SSEEvent) IsDone() bool {
	return strings.TrimSpace(string(e.Data)) == "[DONE]"
}
