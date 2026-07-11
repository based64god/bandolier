package router

import (
	"io"
	"sync"
	"time"

	"github.com/based64god/gollm/api"
)

// routedStream wraps a deployment's stream so router accounting settles
// exactly once when the stream ends: in-flight release, latency EWMA, TPM
// usage, and failure recording for mid-stream errors. Mid-stream failures are
// never re-routed — the caller has already consumed part of the response.
type routedStream struct {
	inner api.ChatStream
	r     *Router
	dep   *deployment
	start time.Time

	mu    sync.Mutex
	usage *api.Usage
	done  bool
}

func (s *routedStream) Recv() (*api.ChatChunk, error) {
	chunk, err := s.inner.Recv()
	switch {
	case err == nil:
		if chunk != nil && chunk.Usage != nil {
			s.mu.Lock()
			s.usage = chunk.Usage
			s.mu.Unlock()
		}
		return chunk, nil
	case err == io.EOF:
		s.finish(true)
		return nil, io.EOF
	default:
		s.r.recordFailure(s.dep, err)
		s.finish(false)
		return nil, err
	}
}

// Close settles accounting (an early Close means the client abandoned the
// stream — not a deployment failure) and releases the connection.
func (s *routedStream) Close() error {
	s.finish(true)
	return s.inner.Close()
}

// finish runs once, whichever of EOF, mid-stream error, or Close comes first.
func (s *routedStream) finish(success bool) {
	s.mu.Lock()
	if s.done {
		s.mu.Unlock()
		return
	}
	s.done = true
	usage := s.usage
	s.mu.Unlock()

	s.dep.inFlight.Add(-1)
	if success {
		s.dep.recordLatency(time.Since(s.start))
		if usage != nil {
			s.dep.recordUsage(time.Now(), usage.TotalTokens)
		}
	}
}
