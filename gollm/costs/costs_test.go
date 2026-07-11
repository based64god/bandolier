package costs

import (
	"math"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

func almostEqual(a, b float64) bool {
	return math.Abs(a-b) <= 1e-12
}

func TestLookupExact(t *testing.T) {
	p, ok := Lookup("gpt-4o")
	if !ok {
		t.Fatal("gpt-4o missing from generated table")
	}
	if p.InputPerToken <= 0 || p.OutputPerToken <= 0 {
		t.Fatalf("gpt-4o has zero pricing: %+v", p)
	}
}

func TestLookupStripsProviderPrefix(t *testing.T) {
	want, ok := Lookup("gpt-4o")
	if !ok {
		t.Fatal("gpt-4o missing")
	}
	// "openai/gpt-4o" is not a table key; stripping the provider segment must
	// find the bare entry.
	got, ok := Lookup("openai/gpt-4o")
	if !ok {
		t.Fatal("openai/gpt-4o did not resolve")
	}
	if got != want {
		t.Fatalf("prefixed lookup = %+v, want %+v", got, want)
	}
}

func TestLookupPrefixMatch(t *testing.T) {
	short := ModelPrice{InputPerToken: 1e-6, OutputPerToken: 2e-6}
	long := ModelPrice{InputPerToken: 3e-6, OutputPerToken: 4e-6}
	Register("lookuptest-model", short)
	Register("lookuptest-model-2025", long)

	// Date-suffixed id resolves via prefix; the longest key wins.
	got, ok := Lookup("lookuptest-model-20250929")
	if !ok {
		t.Fatal("prefix lookup failed")
	}
	if got != long {
		t.Fatalf("prefix lookup = %+v, want longest-key entry %+v", got, long)
	}

	// A real table entry: unknown date suffix on a known claude base id.
	base, ok := Lookup("claude-sonnet-4-5")
	if !ok {
		t.Fatal("claude-sonnet-4-5 missing from generated table")
	}
	got, ok = Lookup("claude-sonnet-4-5-29991231")
	if !ok {
		t.Fatal("date-suffixed claude id did not resolve")
	}
	if got != base {
		t.Fatalf("date-suffixed lookup = %+v, want base entry %+v", got, base)
	}

	if _, ok := Lookup("no-such-model-anywhere/xyz"); ok {
		t.Fatal("nonexistent model resolved")
	}
}

func TestRegisterOverridesBuiltin(t *testing.T) {
	orig, ok := Lookup("gpt-4o")
	if !ok {
		t.Fatal("gpt-4o missing")
	}
	override := ModelPrice{InputPerToken: 42, OutputPerToken: 43}
	Register("gpt-4o", override)
	// Restore so later tests read the built-in table value.
	defer Register("gpt-4o", orig)

	if got, _ := Lookup("gpt-4o"); got != override {
		t.Fatalf("Lookup after Register = %+v, want %+v", got, override)
	}
}

// TestCostCachePricing hand-computes spend for a real anthropic entry, reading
// the price from the generated table so table regeneration can't break it.
func TestCostCachePricing(t *testing.T) {
	const model = "claude-sonnet-4-5-20250929"
	p, ok := Lookup(model)
	if !ok {
		t.Fatalf("%s missing from generated table", model)
	}
	if p.CacheReadPerToken <= 0 || p.CacheWritePerToken <= 0 {
		t.Fatalf("%s should have cache pricing: %+v", model, p)
	}

	usage := &api.Usage{
		PromptTokens:     1000, // includes the cached + cache-written portions
		CompletionTokens: 50,
		PromptTokensDetails: &api.PromptTokensDetails{
			CachedTokens:        200,
			CacheCreationTokens: 100,
		},
	}
	want := 700*p.InputPerToken + 200*p.CacheReadPerToken +
		100*p.CacheWritePerToken + 50*p.OutputPerToken
	if got := Cost(model, usage); !almostEqual(got, want) {
		t.Fatalf("Cost = %v, want %v", got, want)
	}

	// Without detail blocks all prompt tokens bill at the input rate.
	plain := &api.Usage{PromptTokens: 1000, CompletionTokens: 50}
	want = 1000*p.InputPerToken + 50*p.OutputPerToken
	if got := Cost(model, plain); !almostEqual(got, want) {
		t.Fatalf("Cost(no cache details) = %v, want %v", got, want)
	}
}

func TestCostEdgeCases(t *testing.T) {
	if got := Cost("gpt-4o", nil); got != 0 {
		t.Fatalf("Cost(nil usage) = %v, want 0", got)
	}
	if got := Cost("no-such-model-xyz", &api.Usage{PromptTokens: 100}); got != 0 {
		t.Fatalf("Cost(unknown model) = %v, want 0", got)
	}
	// Cached tokens exceeding prompt_tokens clamps the input remainder to 0.
	p, _ := Lookup("gpt-4o")
	u := &api.Usage{
		PromptTokens:        100,
		PromptTokensDetails: &api.PromptTokensDetails{CachedTokens: 150},
	}
	if got, want := Cost("gpt-4o", u), 150*p.CacheReadPerToken; !almostEqual(got, want) {
		t.Fatalf("Cost(over-cached) = %v, want %v", got, want)
	}
}

func TestCompletionCost(t *testing.T) {
	p, ok := Lookup("claude-sonnet-4-5-20250929")
	if !ok {
		t.Fatal("claude entry missing")
	}
	resp := &api.ChatResponse{
		Model:    "claude-sonnet-4-5-20250929",
		Provider: "anthropic",
		Usage:    &api.Usage{PromptTokens: 10, CompletionTokens: 20},
	}
	want := 10*p.InputPerToken + 20*p.OutputPerToken
	if got := CompletionCost(resp); !almostEqual(got, want) {
		t.Fatalf("CompletionCost = %v, want %v", got, want)
	}

	// Bare model unknown, but Provider+"/"+Model registered → fallback path.
	fp := ModelPrice{InputPerToken: 1e-6, OutputPerToken: 2e-6}
	Register("testprov/fallback-only-model", fp)
	resp = &api.ChatResponse{
		Model:    "fallback-only-model",
		Provider: "testprov",
		Usage:    &api.Usage{PromptTokens: 100, CompletionTokens: 10},
	}
	want = 100*fp.InputPerToken + 10*fp.OutputPerToken
	if got := CompletionCost(resp); !almostEqual(got, want) {
		t.Fatalf("CompletionCost(provider fallback) = %v, want %v", got, want)
	}

	if got := CompletionCost(nil); got != 0 {
		t.Fatalf("CompletionCost(nil) = %v, want 0", got)
	}
	if got := CompletionCost(&api.ChatResponse{Model: "gpt-4o"}); got != 0 {
		t.Fatalf("CompletionCost(nil usage) = %v, want 0", got)
	}
}

// TestConcurrentRegisterLookup pins Register's concurrency contract (run with
// -race to make it meaningful).
func TestConcurrentRegisterLookup(t *testing.T) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			Register("race-test-model", ModelPrice{InputPerToken: float64(i)})
		}
	}()
	for i := 0; i < 200; i++ {
		Lookup("race-test-model-20250101") // exercises the prefix scan too
		Cost("gpt-4o", &api.Usage{PromptTokens: 10, CompletionTokens: 1})
	}
	<-done
}

// TestGeneratedTable spot-checks the generated pricing data.
func TestGeneratedTable(t *testing.T) {
	if len(prices) < 100 {
		t.Fatalf("generated table suspiciously small: %d entries", len(prices))
	}
	if _, ok := prices["gpt-4o"]; !ok {
		t.Fatal(`generated table missing "gpt-4o"`)
	}
	var hasClaude, hasGemini bool
	for k := range prices {
		if strings.Contains(k, "claude") {
			hasClaude = true
		}
		if strings.HasPrefix(k, "gemini/") {
			hasGemini = true
		}
	}
	if !hasClaude {
		t.Fatal("generated table has no claude entry")
	}
	if !hasGemini {
		t.Fatal(`generated table has no "gemini/" entry`)
	}
}
