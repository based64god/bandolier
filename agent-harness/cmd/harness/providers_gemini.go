package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"os/exec"
	"strings"
)

// ── Antigravity CLI (agy) — Gemini models ───────────────────────────────────────
//
// Gemini models run through Google's Antigravity CLI (`agy`), the successor to
// the Gemini CLI. The agent is driven non-interactively via `agy --print` (`-p`),
// a first-class headless mode that writes its response to stdout even when stdout
// isn't a terminal. agy has no structured-output flag, so callers parse the plain
// text (the writer prompt already asks for a TITLE:/BODY: format). agy
// authenticates against a Google Cloud project via Application Default
// Credentials; buildEnv materializes the credentials JSON and sets the env.

// agyArgs builds the `agy` argument vector for a one-shot, non-interactive run:
// the prompt is passed directly as the -p value (no shell, so any content is safe)
// and tool actions are auto-approved (the pod is already network-isolated).
func agyArgs(cfg config, prompt string) []string {
	return []string{"-p", prompt, "--model", cfg.model, "--dangerously-skip-permissions"}
}

// agyExec runs agy non-interactively, streaming its output to `stdout` (the
// dashboard tee when nil). stderr is tagged as harness context.
func agyExec(
	ctx context.Context,
	cfg config,
	env []string,
	prompt string,
	stdout io.Writer,
) error {
	out := stdout
	if out == nil {
		out = stdoutTee
	}
	stderr := &prefixWriter{}
	cmd := exec.CommandContext(ctx, "agy", agyArgs(cfg, prompt)...)
	cmd.Dir = cfg.workDir
	cmd.Env = env
	cmd.Stdout = out
	cmd.Stderr = stderr
	runErr := cmd.Run()
	stderr.flush()
	return runErr
}

// runGemini drives agy for a one-shot agent pass: the job is delivered as a
// single prompt (framing folded in, since agy has no system-prompt flag).
func runGemini(ctx context.Context, cfg config, prBranch string) error {
	sysPrompt := cfg.systemPrompt
	if sysPrompt == "" && prBranch != "" {
		sysPrompt = buildRepoSystemPrompt(prBranch)
	}
	sysPrompt = cfg.withRepoPrompt(sysPrompt)

	log.Printf("[harness] starting agy (model=%s)", cfg.model)
	logCodexPrompt("agy prompt:", sysPrompt, cfg.task)

	return agyExec(
		ctx,
		cfg,
		buildEnv(cfg.provider),
		foldSystemPrompt(sysPrompt, cfg.task),
		nil,
	)
}

// runGeminiInteractive drives a long-lived agy conversation. agy's headless mode
// has no stable session-resume, so continuity is maintained by replay: a running
// transcript is prepended to each turn's prompt. Workspace files persist across
// turns (same pod), so code changes accumulate; the replay carries the chat
// context. Between turns it pauses for the user's input polled from Bandolier,
// like the other interactive paths.
func runGeminiInteractive(ctx context.Context, cfg config, first string) error {
	idle := interactiveIdleTimeout()
	env := buildEnv(cfg.provider)

	sysPrompt := cfg.withRepoPrompt(cfg.systemPrompt)
	var convo strings.Builder
	if sysPrompt != "" {
		convo.WriteString(sysPrompt)
		convo.WriteString("\n\n")
	}
	convo.WriteString(
		"# Conversation\n\nContinue as the assistant using the full conversation above for context. Files you change persist between turns.\n\n",
	)

	runTurn := func(msg string) error {
		convo.WriteString("## User\n")
		convo.WriteString(msg)
		convo.WriteString("\n\n## Assistant\n")
		var buf bytes.Buffer
		// The full transcript is written to agy's prompt file, so it can grow
		// without bloating argv; capture the reply to append to the transcript.
		if err := agyExec(ctx, cfg, env, convo.String(), io.MultiWriter(stdoutTee, &buf)); err != nil {
			return err
		}
		convo.WriteString(strings.TrimSpace(buf.String()))
		convo.WriteString("\n\n")
		return nil
	}

	logCodexPrompt("sending initial message:", sysPrompt, first)
	if err := runTurn(first); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}

	for {
		log.Printf("[harness] %s", awaitInputMarker)
		content, ended := awaitInput(ctx, cfg, idle)
		if ended {
			log.Printf("[harness] interactive session ending")
			break
		}
		log.Printf("[harness] %s", resumeMarker)
		if err := runTurn(content); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			log.Printf("[harness] warn: agy turn failed: %v", err)
			break
		}
	}
	return nil
}
