import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Unit-test configuration. Tests target the app's pure logic modules (parsing,
// validation, formatting, crypto token derivation) — no database, network, or
// Kubernetes access is exercised, so the suite runs fast and hermetically in CI.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The DB-backed integration suite shares the `.test.ts` suffix but needs a
    // real Postgres (and its own config); keep it out of the fast unit run. It
    // runs via `pnpm test:integration` (vitest.integration.config.ts).
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
    // Satisfy ~/env validation for modules whose import graph reaches it. These
    // are inert placeholders — no test performs real DB/network/AWS access.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      BETTER_AUTH_SECRET: "test-secret",
      BETTER_AUTH_GITHUB_CLIENT_ID: "test-client-id",
      BETTER_AUTH_GITHUB_CLIENT_SECRET: "test-client-secret",
      // Throwaway 2048-bit RSA key + App id so github-app's JWT signing can be
      // exercised hermetically. Stored `\n`-escaped to mirror how a real PEM
      // lives in env (the broker un-escapes before signing). Not a real secret.
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQClS7FrGMYroDkQ\\nwE64j5ztH9Nx/CmR+bWH2Ujngx0tDD/rcB+ijUNIiV3mw5GRuRsIfWOwq+xgeTf5\\nXBPT3Zx97o9IvGiG3bnFORHXupnLKDr41B+0HIHf7xOCBM23Cl8J3f6OzAOwRLBw\\niuAQv48yFC61PwJJ0k7XaSSN/Q0FEopFqK2HnTAiksKS64zqk/n5twvXPfo69Fpq\\nE+FiqFf+itMdEFX3TFb/7NYTcanxRlguoIHUCNdWaRQFNzPZoQXcA1rliLIbG5Np\\nx5XEJTCa0+G2iPl/nGmPQmxNDkh5gfXxPCi8niRvC5u0onO1UmCDVoG/bEQRuD/o\\ne6aQX0w1AgMBAAECggEABo1IYwnJftN53Uyv0h6xc/lLi7yGdwPwAYp+vwDEmG7O\\nJ4XEhGKpoBVIrdmHOC5WJR7cY5V/Q2FmF7sY5PT5hLajdQaePgySusjXLVubkY6A\\n9Z5FKAHrjRp+Bb8ItiLx9gNOoqE6bVfwPU7oeZznWCX272zMhLUkyJmhLLsOfHzr\\n5Tw4DJm1SXNtWQk+JWzTyEtr7d2hyWb2zYvVUim8lD2D9Yg6WGuf8lBW+FY/0fG1\\nLXi1xk3yAbVQbxDi0DCOV5Ouuk/M+nQV/H7iz/pekVv26QEBp8eLRhtna72XBT6m\\nuxOfKdsmVOV2TyY93Sy7zFbbDrfFF+MEFcycguC7oQKBgQDWEOsoLUxpfHQYwK7c\\nR5LXdEQcE6JuJC4y2o5zVjKDLohctSyVkiJVq2SAMMe4FvwPNYuZt5L31qVLVmME\\nJhTHAMtI0dGO6tkfLhyKV6J4cjUHKO3PL/7SbwnLN4CBYTuhFZor+Q8+lOHqSMub\\nNtM9f6HA/QYiShnNboGNbKzEOwKBgQDFrQOd7++BhdaWkqEe6q4Cl/+HWFiRlxgg\\nW8qGdfi28M2CKBF9bl/N807E+ycOqn+k2C16LBY49WnsEQWOihttBSRNhCYk/l+x\\njqTrGXHbJ+ujcI6DqLKTaljb2M4KZDBtk/7ooIdVWQ6ScexQVHTKuOLDlsJV2NcL\\ndJ1ndxZaTwKBgQDGKYtG+ggOboMaluRITomEocCbLSHkS+HoeaH86wJ/pYfeKmlH\\nXKwkGjFC6eU4aS6U9cBxYBrRCwahIysuIAKD5hxJINKZNpYf4xPQjSd90Ft+cUkT\\nzx5Ztyid0pdHLbeBevnpUvnluPUZaKHy4WHTQF+Aw7n17BrOrUmInd2hGQKBgCwH\\nNigGWf0qVzpgXFyrfqh7PGHj7o427hu+9iPuwL/WcJ+N1x9t5w7TI3dCTVe56AZK\\nVA7DJQv4tWfr/qXZ4vPsUkKlrW1N7vh4QglPOInMoXJczpFKkMO+yx3kczfjStoN\\nPZiIsLv0wwchMrZNqVnBxlg0CwLd8j/N8IUsBCGHAoGATZZhZVOA0coWii1/tXBh\\narMPzPnkWnhcNZm/aeFarLBbb2UzEgIwMM6Vzr87PywPqwL/br4lDPKe1hcO8vBL\\n1rN8XvXxMEKfD2cPiwITTMvzdKO+W7BocABcRryUvkzp7eQHELTzOO0/gm0YpBTR\\nYfKWYbHuKAT0NY7p94lElV0=\\n-----END PRIVATE KEY-----\\n",
    },
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      // json-summary feeds scripts/coverage-badge.mjs, which CI publishes to
      // the `badges` branch for the README's coverage badge.
      reporter: ["text", "html", "lcov", "json-summary"],
      // Only the modules under test carry meaningful coverage; the broader app
      // (React components, tRPC routers, DB glue) is out of scope for unit
      // tests. Test files themselves are excluded by vitest's defaults.
      include: [
        "src/lib/**/*.ts",
        "src/proxy.ts",
        "src/app/api/agent-runs/route.ts",
        "src/app/api/webhooks/github/route.ts",
        "src/server/agents/**/*.ts",
        "src/server/api/rest.ts",
        "src/server/k8s/client.ts",
        "src/app/dashboard/_components/agent-ui.ts",
        "src/app/dashboard/_components/log-segments.ts",
        "src/app/dashboard/_components/notifications.ts",
        "src/app/dashboard/_components/parse-aws.ts",
        "src/app/dashboard/_components/preferred-effort.ts",
        "src/app/dashboard/_components/preferred-model.ts",
        "src/app/dashboard/_components/recent-repos.ts",
        "src/app/dashboard/_components/slash-commands.ts",
        "src/app/dashboard/_components/view-prefs.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
