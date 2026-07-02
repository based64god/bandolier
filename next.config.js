/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

// A unique identifier for this build. Prefer a deploy-provided commit SHA so the
// value is stable across replicas of the same deployment; fall back to a
// build-time timestamp, which still differs between separate builds. Baked into
// both the client bundle and the server (via `env` below) so a running client
// can poll /api/version and notice when a newer build has been deployed.
const buildId =
  process.env.BANDOLIER_BUILD_ID ??
  process.env.SOURCE_COMMIT ??
  process.env.GIT_COMMIT_SHA ??
  String(Date.now());

/** @type {import("next").NextConfig} */
const config = {
  // Emit a self-contained server bundle under `.next/standalone` so the
  // production container image can run the app with just Node and a trimmed
  // node_modules — no full `pnpm install` at runtime. See the web-app
  // Dockerfile (`Dockerfile`) and the Helm chart under `deploy/`.
  output: "standalone",
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
  // Keep asset URLs aligned with the build id so a deploy busts stale chunks.
  generateBuildId: () => buildId,
  serverExternalPackages: [
    "postgres",
    "better-auth",
    "drizzle-orm",
    "@kubernetes/client-node",
  ],
  // The /setup.sh route reads this script from disk; make sure it's bundled into
  // the deployment so the read works in production, not just at build time.
  outputFileTracingIncludes: {
    "/setup.sh": ["./scripts/create-bandolier-kubeconfig.sh"],
  },
};

export default config;
