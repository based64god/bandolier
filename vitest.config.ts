import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit-test configuration. Tests target the app's pure logic modules (parsing,
// validation, formatting, crypto token derivation) — no database, network, or
// Kubernetes access is exercised, so the suite runs fast and hermetically in CI.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Satisfy ~/env validation for modules whose import graph reaches it. These
    // are inert placeholders — no test performs real DB/network/AWS access.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      BETTER_AUTH_SECRET: "test-secret",
      BETTER_AUTH_GITHUB_CLIENT_ID: "test-client-id",
      BETTER_AUTH_GITHUB_CLIENT_SECRET: "test-client-secret",
    },
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "html", "lcov"],
      // Only the modules under test carry meaningful coverage; the broader app
      // (React components, DB/K8s/network glue) is out of scope for unit tests.
      include: [
        "src/lib/**/*.ts",
        "src/server/agents/labels.ts",
        "src/server/agents/namespace.ts",
        "src/server/agents/aws.ts",
        "src/server/agents/github-token.ts",
        "src/server/agents/models.ts",
        "src/server/agents/openai.ts",
        "src/server/agents/gemini.ts",
        "src/server/agents/resolve-credentials.ts",
        "src/server/api/rest.ts",
        "src/app/dashboard/_components/parse-aws.ts",
        "src/app/dashboard/_components/agent-ui.ts",
        "src/app/dashboard/_components/log-segments.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
