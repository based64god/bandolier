package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// ── Serena (semantic code navigation) ──────────────────────────────────────────

// setupSerena wires Serena into the run by registering its MCP server for the
// active provider's CLI, so the agent gets language-server-backed semantic
// navigation tools scoped to the working tree. Each provider registers
// differently: `claude mcp add` and `codex mcp add` write the CLI's own config,
// while Antigravity (agy) has no MCP subcommand and reads a JSON config file. For
// Claude the harness also captures Serena's Claude-Code system-prompt override
// into cfg.serenaPrompt; Codex and Antigravity instead receive Serena's
// tool-preference steer through their respective MCP contexts (--context codex /
// --context antigravity). Every step is best effort — Serena is an enhancement,
// so any failure is logged and the run continues without it rather than aborting.
// No-op when SERENA_DISABLED is set (an escape hatch for debugging) and for
// providers without Serena support.
func setupSerena(ctx context.Context, cfg *config) {
	if os.Getenv("SERENA_DISABLED") != "" {
		return
	}

	switch {
	case cfg.claudeProvider():
		setupSerenaClaude(ctx, cfg)
	case cfg.provider == providerOpenAI:
		setupSerenaCodex(ctx, cfg)
	case cfg.provider == providerGemini:
		setupSerenaAntigravity(cfg)
	}
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

// setupSerenaCodex registers Serena for the Codex CLI via `codex mcp add`, which
// writes ~/.codex/config.toml. --context codex tunes Serena's toolset/prompt for
// Codex (which supplies its own file/shell tools); --project scopes the
// language-server index to the repo. Codex picks up Serena's tool-preference steer
// through the MCP context prompt, so no separate system-prompt capture is needed.
func setupSerenaCodex(ctx context.Context, cfg *config) {
	if err := runCmd(ctx, cfg.workDir, os.Environ(),
		"codex", "mcp", "add", "serena", "--",
		"serena", "start-mcp-server", "--context", "codex", "--project", cfg.workDir,
	); err != nil {
		log.Printf("[harness] warn: registering serena MCP server for codex failed, continuing without it: %v", err)
		return
	}
	log.Printf("[harness] serena enabled (codex MCP server registered)")
}

// setupSerenaAntigravity registers Serena for the Antigravity CLI (agy). Unlike
// claude/codex, agy has no MCP-management subcommand — it reads its MCP servers
// from a JSON config file — so the harness edits that file directly, merging the
// serena entry into any existing config rather than clobbering it. --context
// antigravity tunes Serena's toolset/prompt for the IDE-style agent; --project
// scopes the index to the working tree. agy picks up Serena's steer through the
// MCP context prompt.
func setupSerenaAntigravity(cfg *config) {
	path := antigravityMCPConfigPath()

	cfgMap := map[string]any{}
	if data, err := os.ReadFile(path); err == nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, &cfgMap); err != nil {
			log.Printf("[harness] warn: parsing existing %s failed, continuing without serena: %v", path, err)
			return
		}
	}

	servers, _ := cfgMap["mcpServers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	servers["serena"] = map[string]any{
		"command": "serena",
		"args":    []string{"start-mcp-server", "--context", "antigravity", "--project", cfg.workDir},
	}
	cfgMap["mcpServers"] = servers

	data, err := json.MarshalIndent(cfgMap, "", "  ")
	if err != nil {
		log.Printf("[harness] warn: encoding serena MCP config failed: %v", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.Printf("[harness] warn: could not create %s: %v", filepath.Dir(path), err)
		return
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		log.Printf("[harness] warn: writing serena MCP config failed: %v", err)
		return
	}
	log.Printf("[harness] serena enabled (antigravity MCP config written to %s)", path)
}

// antigravityMCPConfigPath is the JSON file the Antigravity CLI (agy) reads its
// MCP server definitions from. It lives under ~/.gemini/config alongside agy's
// other config.
func antigravityMCPConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "/root"
	}
	return filepath.Join(home, ".gemini", "config", "mcp_config.json")
}
