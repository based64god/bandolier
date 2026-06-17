# syntax=docker/dockerfile:1

# ── Stage 1: build the Go harness binary ──────────────────────────────────────
FROM golang:1.26 AS builder

WORKDIR /build
COPY go.mod ./
RUN go mod download
COPY cmd/ ./cmd/
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
COPY --from=builder /build/harness /usr/local/bin/harness

ENV HOME=/root
ENV PATH="${HOME}/.local/bin:${PATH}"
# Agent CLIs — each vendor's official installer drops a self-contained binary
# into /root/.local/bin (no Node runtime needed); HOME + PATH above put them on
# the runtime PATH. NOTE: the runtime base must be full debian, not -slim — the
# Codex installer's checksum step fails on the slim image (it relies on something
# slim omits), so keep this on debian:latest.
# Claude Code (Anthropic):
RUN curl -fsSL https://claude.ai/install.sh | bash 
# OpenAI Codex:
RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh 
# Google Antigravity (`agy`) — used for Gemini models:
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash 

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/harness"]
