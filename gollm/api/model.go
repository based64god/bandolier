package api

import "strings"

// SplitModel resolves a gollm model string into (provider, model). An
// explicit registered prefix wins: "anthropic/claude-sonnet-4-5" →
// ("anthropic", "claude-sonnet-4-5"); the remainder may itself contain
// slashes ("openrouter/meta-llama/llama-3.3-70b-instruct"). A bare model
// falls back to InferProvider. Mirrors litellm's get_llm_provider.
func SplitModel(model string) (provider, rest string) {
	if idx := strings.IndexByte(model, '/'); idx > 0 {
		prefix := model[:idx]
		if canonical, ok := Resolve(prefix); ok {
			return canonical, model[idx+1:]
		}
	}
	return InferProvider(model), model
}

// inferPrefixes maps bare-model-name prefixes to providers, checked in order.
// Only unambiguous, widely used families are listed; anything else defaults
// to openai (litellm's behavior for unknown bare models).
var inferPrefixes = []struct {
	prefix   string
	provider string
}{
	{"gpt-", "openai"},
	{"chatgpt-", "openai"},
	{"o1", "openai"},
	{"o3", "openai"},
	{"o4", "openai"},
	{"text-embedding-", "openai"},
	{"dall-e", "openai"},
	{"whisper", "openai"},
	{"claude-", "anthropic"},
	{"claude_", "anthropic"},
	{"gemini-", "gemini"},
	{"gemma-", "gemini"},
	{"command", "cohere"},
	{"embed-", "cohere"},
	{"mistral-", "mistral"},
	{"mixtral-", "mistral"},
	{"ministral-", "mistral"},
	{"codestral", "mistral"},
	{"open-mistral", "mistral"},
	{"open-mixtral", "mistral"},
	{"pixtral", "mistral"},
	{"deepseek-", "deepseek"},
	{"grok-", "xai"},
	{"sonar", "perplexity"},
}

// InferProvider guesses the provider for a bare model name.
func InferProvider(model string) string {
	lower := strings.ToLower(model)
	for _, p := range inferPrefixes {
		if strings.HasPrefix(lower, p.prefix) {
			return p.provider
		}
	}
	return "openai"
}
