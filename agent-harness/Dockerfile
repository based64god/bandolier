# syntax=docker/dockerfile:1

# ── Stage 1: build the Go harness binary ──────────────────────────────────────
FROM golang:1.23-bookworm AS builder

WORKDIR /build
COPY go.mod ./
RUN go mod download
COPY cmd/ ./cmd/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o harness ./cmd/harness


# ── Stage 2: runtime image ────────────────────────────────────────────────────
# node:22-bookworm-slim already includes Node 22, npm, and a "node" user (uid 1000).
FROM node:22-bookworm-slim

# System tools: git for repo operations, curl + ca-certs for the gh install
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

# Claude Code CLI — installs the `claude` binary to /usr/local/bin/claude
RUN npm install -g @anthropic-ai/claude-code

# Harness binary from the builder stage
COPY --from=builder /build/harness /usr/local/bin/harness

# Give the pre-existing "node" user (uid 1000) a writable workspace.
RUN mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/harness"]
