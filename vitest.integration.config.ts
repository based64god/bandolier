import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration-test configuration — DISTINCT from vitest.config.ts (the fast,
// hermetic unit suite). These tests run real tRPC procedures and route handlers
// against a REAL, migrated Postgres, so they:
//   - match only *.integration.test.ts (kept out of the unit `include` glob, so
//     unit runtime and the coverage-badge numbers are untouched),
//   - require DATABASE_URL to point at a throwaway Postgres; the globalSetup
//     migrates it with the production migrations before any test runs,
//   - run in forked processes with file parallelism OFF, since every file shares
//     the one database and truncates between tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/test/integration/global-setup.ts"],
    // One shared database → run files sequentially so their TRUNCATEs don't
    // race each other. Forks give each file a clean module registry.
    pool: "forks",
    fileParallelism: false,
    // Inert placeholders for the env vars ~/env validates at import time. NOT
    // DATABASE_URL — that comes from the real (throwaway) Postgres the caller
    // and globalSetup point at. Mirrors vitest.config.ts otherwise.
    env: {
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "test-secret",
      BETTER_AUTH_GITHUB_CLIENT_ID: "test-client-id",
      BETTER_AUTH_GITHUB_CLIENT_SECRET: "test-client-secret",
      // Fixed so the HMAC signers in src/test/integration/auth-material.ts derive
      // the same webhook signature / ingest token the real handlers verify.
      GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    },
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws when imported outside an RSC graph; alias it to an
      // empty module so routers/routes that (transitively) import it — push, the
      // acp route — load under plain Node in tests. This mirrors what the RSC
      // react-server export condition does in production. An alias (not just
      // resolve.conditions) is required: vitest externalizes node_modules, and
      // Node's own resolver ignores the react-server condition.
      "server-only": fileURLToPath(
        new URL("./src/test/integration/empty.ts", import.meta.url),
      ),
    },
    conditions: ["node", "react-server"],
  },
});
