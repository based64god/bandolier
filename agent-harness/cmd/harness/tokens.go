package main

import (
	"encoding/json"
	"log"
	"strings"
)

// tokenMarkerPrefix tags a log line carrying the run's cumulative token usage as
// a compact JSON object, e.g. `BANDOLIER_TOKENS={"input_tokens":4,...}`. Like the
// PR_URL/ISSUE_URL markers, it rides the pod log (and the persisted transcript)
// so Bandolier can surface and persist the count without a side channel. The
// server greps the most recent occurrence, so emitting the running total each
// turn keeps the readout live for interactive sessions.
const tokenMarkerPrefix = "BANDOLIER_TOKENS="

// tokenUsage is the per-run token accounting reported by the agent CLIs. The
// fields mirror Anthropic's usage shape (the claude CLI's stream-json `result`
// event); cache fields are zero for providers that don't report them. Kept flat
// (no nested objects) so the server can extract it with a single-brace regex.
type tokenUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
}

// empty reports whether no tokens were recorded — used to skip emitting a marker
// for an event that carried no usage.
func (u tokenUsage) empty() bool {
	return u.InputTokens == 0 &&
		u.OutputTokens == 0 &&
		u.CacheReadInputTokens == 0 &&
		u.CacheCreationInputTokens == 0
}

// add accumulates another turn's usage into this one. Interactive sessions drive
// many turns through one long-lived process; summing keeps a session-wide total.
func (u *tokenUsage) add(o tokenUsage) {
	u.InputTokens += o.InputTokens
	u.OutputTokens += o.OutputTokens
	u.CacheReadInputTokens += o.CacheReadInputTokens
	u.CacheCreationInputTokens += o.CacheCreationInputTokens
}

// latestTokenMarker scans a transcript for the most recent token marker and
// returns its JSON payload (the substring after the prefix, e.g.
// `{"input_tokens":4,...}`). Returns "" when none is present. The last marker
// wins: one-shot runs emit once, interactive runs emit a growing total per turn,
// so the final occurrence is the run's cumulative figure.
func latestTokenMarker(transcript string) string {
	idx := strings.LastIndex(transcript, tokenMarkerPrefix)
	if idx < 0 {
		return ""
	}
	rest := transcript[idx+len(tokenMarkerPrefix):]
	if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
		rest = rest[:nl]
	}
	return strings.TrimSpace(rest)
}

// logTokenUsage emits the token marker into the pod log / transcript. No-op for
// empty usage so a provider that reports nothing leaves no misleading "0" marker.
func logTokenUsage(u tokenUsage) {
	if u.empty() {
		return
	}
	b, err := json.Marshal(u)
	if err != nil {
		return
	}
	log.Printf("[harness] %s%s", tokenMarkerPrefix, b)
}
