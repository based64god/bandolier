// Package all blank-imports every built-in provider so importing it (or the
// root gollm package) registers them all.
package all

import (
	_ "github.com/based64god/gollm/providers/anthropicp"
	_ "github.com/based64god/gollm/providers/azure"
	_ "github.com/based64god/gollm/providers/bedrock"
	_ "github.com/based64god/gollm/providers/bytez"
	_ "github.com/based64god/gollm/providers/chatgpt"
	_ "github.com/based64god/gollm/providers/cohere"
	_ "github.com/based64god/gollm/providers/compat"
	_ "github.com/based64god/gollm/providers/copilot"
	_ "github.com/based64god/gollm/providers/gemini"
	_ "github.com/based64god/gollm/providers/gigachat"
	_ "github.com/based64god/gollm/providers/nlpcloud"
	_ "github.com/based64god/gollm/providers/oci"
	_ "github.com/based64god/gollm/providers/ollama"
	_ "github.com/based64god/gollm/providers/openai"
	_ "github.com/based64god/gollm/providers/petals"
	_ "github.com/based64god/gollm/providers/predibase"
	_ "github.com/based64god/gollm/providers/replicate"
	_ "github.com/based64god/gollm/providers/snowflake"
	_ "github.com/based64god/gollm/providers/triton"
	_ "github.com/based64god/gollm/providers/vertex"
	_ "github.com/based64god/gollm/providers/watsonx"
)
