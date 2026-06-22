# bandolier-self-host — the agent harness plus the Go and Node toolchains this
# repo is built with, so the image can build and run Bandolier itself (not just
# drive agents). It also carries Chromium + Playwright so agents can drive a
# headless browser to inspect site visuals.
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

# ── Chromium + Playwright ─────────────────────────────────────────────────────
# So agents can drive a headless browser to inspect site visuals (screenshots,
# rendered DOM, layout). We install Debian's own Chromium, then install Playwright
# globally and point it at the system binary — PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# keeps Playwright from fetching a second, bundled copy, so the browser can never
# drift from the one the OS patches. (The base image is debian:latest, which
# ships chromium.)
#
# The chromium package already depends on the shared libraries a headless browser
# needs, so apt pulls those in — we don't hand-list them (their names churn, e.g.
# the Debian t64 transition). Fonts are only a recommends, so we add them
# explicitly for correct text/emoji rendering in screenshots.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD stops Playwright from fetching its own bundled
# browsers; PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points launches at the system
# Chromium installed above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
RUN npm install -g playwright-core playwright

# Fail the build loudly if the browser can't launch headless on this image.
RUN chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null

# Inherit the harness ENTRYPOINT (/usr/local/bin/harness) and env (HOME, PATH,
# IS_SANDBOX, …) from the base image.
