package main

import (
	"context"
	"log"
	"os"
	"strings"
)

// ── Serena (semantic code navigation) ──────────────────────────────────────────

// setupSerena wires Serena into the run by registering its MCP server with the
// claude CLI (which drives every provider), so the agent gets
// language-server-backed semantic navigation tools scoped to the working tree.
// Every step is best effort — Serena is an enhancement, so any failure is
// logged and the run continues without it rather than aborting. No-op when
// SERENA_DISABLED is set (an escape hatch for debugging).
func setupSerena(ctx context.Context, cfg *config) {
	if os.Getenv("SERENA_DISABLED") != "" {
		return
	}
	setupSerenaClaude(ctx, cfg)
}

// setupSerenaClaude registers Serena for the claude CLI (user scope, so every
// `claude` invocation this run makes picks it up) and captures Serena's
// Claude-Code system-prompt override into cfg.serenaPrompt so withRepoPrompt
// appends it to the framing. --context claude-code tunes Serena's toolset/prompts
// for Claude Code; --project scopes its language-server index to the repo.
func setupSerenaClaude(ctx context.Context, cfg *config) {
	if err := runCmd(ctx, cfg.workDir, os.Environ(),
		"claude", "mcp", "add", "--scope", "user", "serena", "--",
		"serena", "start-mcp-server", "--context", "claude-code", "--project", cfg.workDir,
	); err != nil {
		log.Printf("[harness] warn: registering serena MCP server failed, continuing without it: %v", err)
		return
	}

	// Capture Serena's Claude-Code system-prompt override, which steers Claude
	// toward Serena's semantic navigation tools over the built-in file tools.
	out, err := captureCmd(ctx, cfg.workDir, "serena", "prompts", "print-cc-system-prompt-override")
	if err != nil {
		log.Printf("[harness] warn: fetching serena system-prompt override failed: %v", err)
		return
	}
	cfg.serenaPrompt = strings.TrimSpace(out)
	log.Printf("[harness] serena enabled (claude MCP server registered, system-prompt override applied)")
}
