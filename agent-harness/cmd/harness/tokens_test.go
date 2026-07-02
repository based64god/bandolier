package main

import (
	"log"
	"testing"
)

func TestTokenUsageEmpty(t *testing.T) {
	if !(tokenUsage{}).empty() {
		t.Fatal("zero usage should be empty")
	}
	if (tokenUsage{InputTokens: 1}).empty() {
		t.Fatal("non-zero usage should not be empty")
	}
	if (tokenUsage{CacheReadInputTokens: 5}).empty() {
		t.Fatal("cache-only usage should not be empty")
	}
}

func TestTokenUsageAdd(t *testing.T) {
	u := tokenUsage{InputTokens: 1, OutputTokens: 2, CacheReadInputTokens: 3, CacheCreationInputTokens: 4}
	u.add(tokenUsage{InputTokens: 10, OutputTokens: 20, CacheReadInputTokens: 30, CacheCreationInputTokens: 40})
	want := tokenUsage{InputTokens: 11, OutputTokens: 22, CacheReadInputTokens: 33, CacheCreationInputTokens: 44}
	if u != want {
		t.Fatalf("add: got %+v want %+v", u, want)
	}
}

func TestLatestTokenMarker(t *testing.T) {
	cases := []struct {
		name       string
		transcript string
		want       string
	}{
		{"none", "no markers here\n", ""},
		{
			"single",
			"some log\n[harness] BANDOLIER_TOKENS={\"input_tokens\":4,\"output_tokens\":5}\nmore\n",
			"{\"input_tokens\":4,\"output_tokens\":5}",
		},
		{
			"last wins",
			"[harness] BANDOLIER_TOKENS={\"input_tokens\":1}\n" +
				"[harness] BANDOLIER_TOKENS={\"input_tokens\":9}\n",
			"{\"input_tokens\":9}",
		},
		{
			"no trailing newline",
			"[harness] BANDOLIER_TOKENS={\"output_tokens\":7}",
			"{\"output_tokens\":7}",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := latestTokenMarker(tc.transcript); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestHandleClaudeEventEmitsTokenMarker(t *testing.T) {
	// logTokenUsage writes through the log package; point it at a buffer so the
	// emitted marker is observable, matching how the transcript captures it.
	var buf syncBuffer
	origOut := log.Writer()
	origFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(origOut)
		log.SetFlags(origFlags)
	}()

	handleClaudeEvent([]byte(`{"type":"result","subtype":"success","num_turns":3,"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10}}`))

	got := latestTokenMarker(buf.String())
	want := `{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":0}`
	if got != want {
		t.Fatalf("marker = %q want %q", got, want)
	}

	// A result event with no usage must not emit a marker.
	buf = syncBuffer{}
	handleClaudeEvent([]byte(`{"type":"result","subtype":"success","num_turns":1}`))
	if got := latestTokenMarker(buf.String()); got != "" {
		t.Fatalf("empty usage should emit no marker, got %q", got)
	}
}
