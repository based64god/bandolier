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
#   - Node: package.json `engines.node` ("26.x") + CI's node-version (26)
# The defaults below mirror those so the image also builds locally without args.

ARG GO_IMAGE=golang:1.26
ARG NODE_IMAGE=node:26

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

# gopls — the Go language server, so Serena (installed in the base harness
# image) gets language-server-backed symbol tools for Go code. Installed into
# /root/go/bin (GOPATH/bin, on PATH above); the module/build caches are only
# build residue, so drop them to keep the layer small.
RUN go install golang.org/x/tools/gopls@latest \
    && go clean -cache -modcache

# ── Node.js (+ npm, corepack) ─────────────────────────────────────────────────
# Copy the node binary and its bundled modules, then recreate the launcher
# symlinks the official node image ships (relative, so they resolve under
# /usr/local). corepack provides pnpm — this repo's package manager; Node 25+
# no longer bundles it, so install it from npm rather than symlinking it in.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g corepack@latest \
    && corepack enable

# Fail the build loudly if either toolchain (or gopls) can't run on the base image.
RUN go version && gopls version && node --version && npm --version

# ── Warm the pnpm store ───────────────────────────────────────────────────────
# Prefetch this repo's dependencies into pnpm's content-addressable store so a
# downstream `pnpm install` in the mounted checkout links from the store instead
# of downloading from the network — the slow (and, in a network-restricted pod,
# sometimes impossible) part of a cold install. Only the lockfile + pnpm config
# are needed: `pnpm fetch` resolves purely from pnpm-lock.yaml (the manifest is
# ignored), package.json is copied so corepack selects the pinned pnpm, and
# pnpm-workspace.yaml carries patchedDependencies / onlyBuiltDependencies.
#
# PNPM_HOME fixes the store at /root/.local/share/pnpm/store so this warm and the
# downstream install (same root HOME) resolve to the *same* store — pnpm has no
# env var for store-dir, but it derives the default store from PNPM_HOME. It also
# puts pnpm's global bin dir on PATH. CI=1 lets pnpm run non-interactively.
#
# Requires the build context to be the repo root (see self-host-image.yml), since
# these files live under web/, a sibling of self-host/.
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /opt/pnpm-warm
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/.npmrc ./
COPY web/patches ./patches
RUN CI=1 pnpm fetch && rm -rf node_modules
WORKDIR /workspace

# ── Chromium + Playwright ─────────────────────────────────────────────────────
# So agents can drive a headless browser to inspect site visuals (screenshots,
# rendered DOM, layout). We install Playwright globally and let it manage its own
# Chromium: `playwright install --with-deps chromium` fetches the exact browser
# build Playwright is tested against and apt-installs the shared libraries a
# headless browser needs. Letting the installer resolve those libs (rather than
# hand-listing them, or reusing Debian's chromium and pointing Playwright at it —
# Playwright has no env var to override the executable path, only the bundled
# browser it downloads) keeps us off the treadmill of churning package names
# (e.g. the Debian t64 transition). The emoji font isn't among Playwright's deps,
# so we add it explicitly for correct emoji rendering in screenshots.
RUN npm install -g playwright-core playwright \
    && playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Fail the build loudly if Playwright can't actually launch its Chromium headless.
# NODE_PATH lets `require` resolve the globally-installed package; --no-sandbox
# because the image runs as root.
RUN NODE_PATH=/usr/local/lib/node_modules node -e "require('playwright').chromium.launch({args:['--no-sandbox']}).then(b=>b.close()).then(()=>console.log('playwright chromium ok')).catch(e=>{console.error(e);process.exit(1)})"

# Inherit the harness ENTRYPOINT (/usr/local/bin/harness) and env (HOME, PATH,
# IS_SANDBOX, …) from the base image.
