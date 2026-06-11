/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
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
