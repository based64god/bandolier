// Package costs prices token usage in USD against litellm's model pricing
// table (see pricing_data.go). Lookups tolerate the model-id spellings that
// occur in practice — provider-prefixed ids, bare ids, and date-suffixed
// releases — so spend tracking works on whatever id a response reports.
package costs

import (
	"strings"
	"sync"

	"github.com/based64god/gollm/api"
)

// ModelPrice is per-token USD pricing plus context-window limits for one
// model. Zero cost fields mean "not priced" (e.g. no cache pricing), not free.
type ModelPrice struct {
	InputPerToken, OutputPerToken         float64
	CacheReadPerToken, CacheWritePerToken float64
	MaxInputTokens, MaxOutputTokens       int
}

// custom holds Register-ed entries, consulted before the generated table so
// applications can add private models or override built-in prices.
var (
	customMu sync.RWMutex
	custom   = map[string]ModelPrice{}
)

// Register installs or overrides pricing for a model id. Safe for concurrent
// use with Lookup/Cost.
func Register(model string, p ModelPrice) {
	customMu.Lock()
	defer customMu.Unlock()
	custom[model] = p
}

// Lookup resolves pricing for a model id. Resolution order: exact key; exact
// key with the leading "provider/" segment stripped; then the longest table
// key that is a prefix of either spelling (so a date-suffixed release like
// claude-sonnet-4-5-20250929 resolves to its claude-sonnet-4-5 base entry).
// Registered entries win over built-ins at equal specificity.
func Lookup(model string) (ModelPrice, bool) {
	if p, ok := lookupExact(model); ok {
		return p, true
	}
	stripped := model
	if i := strings.IndexByte(model, '/'); i >= 0 {
		stripped = model[i+1:]
		if p, ok := lookupExact(stripped); ok {
			return p, true
		}
	}
	return lookupPrefix(model, stripped)
}

func lookupExact(model string) (ModelPrice, bool) {
	customMu.RLock()
	p, ok := custom[model]
	customMu.RUnlock()
	if ok {
		return p, true
	}
	p, ok = prices[model]
	return p, ok
}

// lookupPrefix finds the longest key that prefixes any candidate spelling.
// custom is scanned first, so on a length tie a registered entry wins.
func lookupPrefix(candidates ...string) (ModelPrice, bool) {
	var best ModelPrice
	bestLen := -1
	scan := func(table map[string]ModelPrice) {
		for k, v := range table {
			if len(k) <= bestLen {
				continue
			}
			for _, c := range candidates {
				if strings.HasPrefix(c, k) {
					best, bestLen = v, len(k)
					break
				}
			}
		}
	}
	customMu.RLock()
	scan(custom)
	customMu.RUnlock()
	scan(prices)
	return best, bestLen >= 0
}

// Cost prices a usage block in USD. Cached prompt tokens bill at
// CacheReadPerToken, cache-creation tokens at CacheWritePerToken, and the
// remaining prompt tokens at InputPerToken (unified PromptTokens includes the
// cached portions, per api.Usage). Nil usage or an unknown model prices to 0.
func Cost(model string, usage *api.Usage) float64 {
	if usage == nil {
		return 0
	}
	p, ok := Lookup(model)
	if !ok {
		return 0
	}
	var cached, written int
	if d := usage.PromptTokensDetails; d != nil {
		cached = d.CachedTokens
		written = d.CacheCreationTokens
	}
	text := usage.PromptTokens - cached - written
	if text < 0 {
		// Some providers report prompt_tokens excluding the cached portion;
		// clamp rather than emitting a negative component (litellm does too).
		text = 0
	}
	return float64(text)*p.InputPerToken +
		float64(cached)*p.CacheReadPerToken +
		float64(written)*p.CacheWritePerToken +
		float64(usage.CompletionTokens)*p.OutputPerToken
}

// CompletionCost prices a full response: Lookup on the model id the response
// reports, falling back to the "provider/model" spelling for providers whose
// table entries are prefix-keyed (e.g. "gemini/...").
func CompletionCost(resp *api.ChatResponse) float64 {
	if resp == nil {
		return 0
	}
	model := resp.Model
	if _, ok := Lookup(model); !ok && resp.Provider != "" {
		model = resp.Provider + "/" + resp.Model
	}
	return Cost(model, resp.Usage)
}
