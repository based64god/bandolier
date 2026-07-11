# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT (not this directory): the harness embeds the
# vendored gollm module (../gollm via a go.mod replace), so both trees must be
# in the context. CI passes `context: .` with `file: agent-harness/Dockerfile`.

# ── Stage 1: build the Go harness binary ──────────────────────────────────────
FROM golang:1.26 AS builder

WORKDIR /build
# The gollm module first (the harness's go.mod replaces ../gollm with it).
COPY gollm/ ./gollm/
COPY agent-harness/go.mod agent-harness/go.sum ./agent-harness/
WORKDIR /build/agent-harness
RUN go mod download
COPY agent-harness/cmd/ ./cmd/
COPY agent-harness/internal/ ./internal/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o harness ./cmd/harness


# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM debian:latest

# System tools: git for repo operations, curl + ca-certs for the installers and gh.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — from the official apt repo
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Harness binary from the builder stage (root-owned, world-executable, on PATH).
COPY --from=builder /build/agent-harness/harness /usr/local/bin/harness

ENV HOME=/root
ENV PATH="${HOME}/.local/bin:${PATH}"
# The pod runs as root (the CLI lives under /root); Claude Code otherwise refuses
# to use --dangerously-skip-permissions as root. IS_SANDBOX=1 signals that the
# isolated, network-restricted pod is the sandbox, so root is allowed.
ENV IS_SANDBOX=1
# Claude Code is the only agent CLI: non-Anthropic providers (OpenAI, ChatGPT
# subscription, Gemini, Vertex) are served by the harness's embedded gollm
# proxy, which rewrites Claude Code's Anthropic-format traffic to the run's
# real backend. The vendor installer drops a self-contained binary into
# /root/.local/bin (no Node runtime needed).
RUN curl -fsSL https://claude.ai/install.sh | bash

# Serena — semantic code-navigation MCP server, included in the default harness
# so agent runs get language-server-backed symbol tools. Installed with uv (the
# vendor's recommended path; marketplace/pip installs ship outdated launch
# commands). `uv tool install` drops the `serena` binary into /root/.local/bin,
# already on PATH above. The MCP server itself is registered per-run by the Go
# harness via `claude mcp add`, so nothing to configure here beyond the CLI.
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
    && /root/.local/bin/uv tool install -p 3.13 serena-agent

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/harness"]
