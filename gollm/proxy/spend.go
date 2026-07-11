package proxy

import (
	"sync"
	"time"
)

// SpendEntry records one completed request for the /spend/logs endpoint and
// operator visibility.
type SpendEntry struct {
	Timestamp        time.Time     `json:"timestamp"`
	KeyAlias         string        `json:"key_alias,omitempty"`
	ModelAlias       string        `json:"model"`
	Endpoint         string        `json:"endpoint"` // "messages" | "chat" | "embeddings"
	Stream           bool          `json:"stream,omitempty"`
	PromptTokens     int           `json:"prompt_tokens"`
	CompletionTokens int           `json:"completion_tokens"`
	Cost             float64       `json:"cost_usd"`
	Duration         time.Duration `json:"duration_ns"`
	Status           int           `json:"status"`
	Error            string        `json:"error,omitempty"`
}

// spendLog is a fixed-size ring of recent entries plus running totals.
type spendLog struct {
	mu      sync.Mutex
	entries []SpendEntry
	next    int
	full    bool
	total   float64
}

const spendLogSize = 1000

func newSpendLog() *spendLog {
	return &spendLog{entries: make([]SpendEntry, spendLogSize)}
}

func (l *spendLog) add(e SpendEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries[l.next] = e
	l.next = (l.next + 1) % len(l.entries)
	if l.next == 0 {
		l.full = true
	}
	l.total += e.Cost
}

// recent returns up to n most-recent entries, newest first.
func (l *spendLog) recent(n int) []SpendEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	size := l.next
	if l.full {
		size = len(l.entries)
	}
	if n > size {
		n = size
	}
	out := make([]SpendEntry, 0, n)
	for i := 1; i <= n; i++ {
		idx := (l.next - i + len(l.entries)) % len(l.entries)
		out = append(out, l.entries[idx])
	}
	return out
}

func (l *spendLog) totalSpend() float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.total
}
