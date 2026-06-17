# bandolier-self-host — the agent harness plus the Go and Node toolchains this
# repo is built with, so the image can build and run Bandolier itself (not just
# drive agents).
#
# Layered on top of the published agent-harness image (which already carries the
# agent CLIs, git, and gh). The Go and Node versions are pinned to match the
# repo's build and are normally supplied by the CI workflow, which reads them
# from agent-harness/go.mod and package.json so they can never drift:
#   - Go:   agent-harness/go.mod (`go 1.26`) + the golang:1.26 builder image
#   - Node: package.json `engines.node` ("24.x") + CI's node-version (24)
# The defaults below mirror those so the image also builds locally without args.

ARG GO_IMAGE=golang:1.26
ARG NODE_IMAGE=node:24

FROM ${GO_IMAGE} AS go
FROM ${NODE_IMAGE} AS node

FROM ghcr.io/based64god/bandolier-agent-harness:latest

# ── Go toolchain ──────────────────────────────────────────────────────────────
# Copied wholesale from the same image the harness binary is compiled with, so
# the in-container `go` is byte-for-byte the build toolchain.
COPY --from=go /usr/local/go /usr/local/go
ENV GOROOT=/usr/local/go
ENV GOPATH=/root/go
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# ── Node.js (+ npm, corepack) ─────────────────────────────────────────────────
# Copy the node binary and its bundled modules, then recreate the launcher
# symlinks the official node image ships (relative, so they resolve under
# /usr/local). corepack provides pnpm — this repo's package manager.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable

# Fail the build loudly if either toolchain can't run on the base image.
RUN go version && node --version && npm --version

# Inherit the harness ENTRYPOINT (/usr/local/bin/harness) and env (HOME, PATH,
# IS_SANDBOX, …) from the base image.
