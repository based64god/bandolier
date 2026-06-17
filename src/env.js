import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
    BETTER_AUTH_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string()
        : z.string().optional(),
    BETTER_AUTH_GITHUB_CLIENT_ID: z.string(),
    BETTER_AUTH_GITHUB_CLIENT_SECRET: z.string(),
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    K8S_LABEL_SELECTOR: z.string().default("app=bandolier-agent"),
    // Network isolation for agent pods. When enabled, each agent namespace gets a
    // NetworkPolicy that denies all inbound traffic and restricts egress to DNS +
    // the public internet — blocking lateral movement to other pods/services.
    // Requires a policy-enforcing CNI (Calico/Cilium); a no-op under kindnet.
    AGENT_NETWORK_POLICY: z.enum(["true", "false"]).default("true"),
    // CIDRs excluded from agent egress (i.e. unreachable). Defaults to the
    // RFC-1918 private ranges, which cover the pod/service CIDRs, node IPs, and
    // any in-cluster private services. Comma-separated; tune per cluster.
    AGENT_EGRESS_BLOCKED_CIDRS: z
      .string()
      .default("10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_TRIGGER_LABEL: z.string().optional(),
    // OAuth/PAT token for the dedicated Bandolier GitHub service user. When set,
    // automated issue comments ("Bando picked up this issue…") are posted as
    // this user instead of the issue author, so the notice is clearly attributed
    // to the bot. Falls back to the triggering user's token when unset.
    BANDOLIER_GITHUB_TOKEN: z.string().optional(),
    // Optional shared password gate in front of the whole app (UI + API). When
    // set, visitors must enter it before reaching anything (the GitHub webhook
    // is exempt — it authenticates via signature). Unset = gate disabled.
    APP_PASSWORD: z.string().optional(),
    // Object storage for persisted run artifacts (transcripts now; workspaces
    // later). Persistence is enabled only when a bucket is set. Credentials fall
    // back to the default AWS provider chain when the explicit pair is unset.
    ARTIFACTS_S3_BUCKET: z.string().optional(),
    ARTIFACTS_S3_REGION: z.string().default("us-east-1"),
    ARTIFACTS_S3_ENDPOINT: z.string().optional(), // for MinIO / S3-compatible
    ARTIFACTS_AWS_ACCESS_KEY_ID: z.string().optional(),
    ARTIFACTS_AWS_SECRET_ACCESS_KEY: z.string().optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_GITHUB_CLIENT_ID: process.env.BETTER_AUTH_GITHUB_CLIENT_ID,
    BETTER_AUTH_GITHUB_CLIENT_SECRET:
      process.env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    K8S_LABEL_SELECTOR: process.env.K8S_LABEL_SELECTOR,
    AGENT_NETWORK_POLICY: process.env.AGENT_NETWORK_POLICY,
    AGENT_EGRESS_BLOCKED_CIDRS: process.env.AGENT_EGRESS_BLOCKED_CIDRS,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    GITHUB_TRIGGER_LABEL: process.env.GITHUB_TRIGGER_LABEL,
    BANDOLIER_GITHUB_TOKEN: process.env.BANDOLIER_GITHUB_TOKEN,
    APP_PASSWORD: process.env.APP_PASSWORD,
    ARTIFACTS_S3_BUCKET: process.env.ARTIFACTS_S3_BUCKET,
    ARTIFACTS_S3_REGION: process.env.ARTIFACTS_S3_REGION,
    ARTIFACTS_S3_ENDPOINT: process.env.ARTIFACTS_S3_ENDPOINT,
    ARTIFACTS_AWS_ACCESS_KEY_ID: process.env.ARTIFACTS_AWS_ACCESS_KEY_ID,
    ARTIFACTS_AWS_SECRET_ACCESS_KEY:
      process.env.ARTIFACTS_AWS_SECRET_ACCESS_KEY,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
