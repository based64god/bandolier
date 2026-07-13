# bandolier web app — the Next.js + tRPC dashboard/server (this repo's `src/`).
#
# This is the image you run to self-host Bandolier itself. It is distinct from
# the two agent-side images:
#   - agent-harness/Dockerfile  — the Go binary + CLIs that run *inside* each
#     agent Job pod.
#   - self-host/Dockerfile       — a heavy toolchain image (harness + Go + Node +
#     Chromium) used to *build* the repo, not to serve it.
#
# The build uses Next.js standalone output (next.config.js → output:
# "standalone") so the final stage carries only Node, a trimmed node_modules,
# and the compiled server — no pnpm install at runtime. Published by
# .github/workflows/web-app-image.yml; deployed via the Helm chart under
# deploy/helm/bandolier.

ARG NODE_IMAGE=node:24-slim

# ── deps ──────────────────────────────────────────────────────────────────────
# Install the full dependency set (incl. dev deps needed to build) with pnpm,
# honoring the repo's pinned version via corepack and its patched dependencies.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable
# Lockfile + manifest + patches first, so this layer caches unless deps change.
# pnpm-workspace.yaml carries the pnpm settings (patchedDependencies,
# allowBuilds) that pnpm 11 no longer reads from package.json.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── builder ───────────────────────────────────────────────────────────────────
# Compile the Next.js app. Env validation (src/env.js) is skipped at build time —
# real values are supplied at runtime by the Deployment — matching the note in
# next.config.js.
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
# Next prerenders a few static pages at build time, which pulls in the auth
# config (better-auth does `new URL(BETTER_AUTH_URL)`). With env validation
# skipped the zod default doesn't apply, so give the build a harmless
# placeholder — the real value is supplied at runtime by the Deployment and is
# what the running server actually uses.
ENV BETTER_AUTH_URL=http://localhost:3000
# A deploy-provided commit SHA keeps the build id stable across replicas of the
# same deploy (see next.config.js); the CI workflow passes it through.
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
RUN pnpm build

# ── migrator ──────────────────────────────────────────────────────────────────
# A minimal layer carrying just what `drizzle-kit migrate` needs: the CLI, the
# schema/config, and the generated SQL under drizzle/. The Helm chart runs this
# as a pre-install/pre-upgrade Job (overriding the image entrypoint) so the
# database schema is applied before the app rolls out.
FROM ${NODE_IMAGE} AS migrator
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts tsconfig.json ./
COPY drizzle ./drizzle
COPY src/env.js ./src/env.js
COPY src/server/db/schema.ts ./src/server/db/schema.ts
ENV NODE_ENV=production
# drizzle.config.ts imports ~/env for DATABASE_URL; the other server vars aren't
# needed just to migrate, so skip full env validation here.
ENV SKIP_ENV_VALIDATION=1
USER node
# Invoke the drizzle-kit binary directly rather than via pnpm/corepack — corepack
# would try to fetch pnpm at runtime (needs network + a writable home), which
# breaks under the read-only rootfs the Helm chart runs this Job with.
CMD ["node_modules/.bin/drizzle-kit", "migrate"]

# ── runner ──────────────────────────────────────────────────────────────────────
# The lean production image. Next standalone output bundles the server and only
# the node_modules it actually traces, so we don't ship pnpm or dev deps.
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as the unprivileged `node` user shipped by the base image.
USER node

# standalone/ contains server.js + the traced node_modules; static/ and public/
# are served alongside it. outputFileTracingIncludes (next.config.js) pulls in
# scripts/create-bandolier-kubeconfig.sh for the /setup.sh route.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

EXPOSE 3000

# server.js is the standalone entrypoint Next emits; it reads PORT/HOSTNAME.
CMD ["node", "server.js"]
