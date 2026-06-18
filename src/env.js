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
    // ── GitHub App (bot identity) ─────────────────────────────────────────────
    // Credentials for the Bandolier GitHub App, which owns every action that
    // speaks *as the bot* rather than as a user — issue/PR comments and other UX
    // tie-ins. The user OAuth token still drives all attribution-sensitive work
    // (clone/push/PR authorship); the App never touches those. All three are
    // required together to enable bot actions; unset = bot actions are skipped.
    //
    // GITHUB_APP_ID:          the numeric App id from the App's settings page.
    // GITHUB_APP_PRIVATE_KEY: a PEM private key generated for the App. Multi-line
    //                         PEMs survive in env as `\n`-escaped strings; the
    //                         broker un-escapes them before signing.
    // GITHUB_APP_CLIENT_ID:   the App's OAuth client id, used (with the secret)
    //                         to authorize users via the App rather than the
    //                         legacy OAuth app. Optional until login is moved.
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_CLIENT_ID: z.string().optional(),
    GITHUB_APP_CLIENT_SECRET: z.string().optional(),
    // DEPRECATED: superseded by the GitHub App above. When the App is configured,
    // bot comments are posted as the App installation and this is ignored. Kept
    // as a fallback so deployments without the App configured keep working.
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
    // Web Push (VAPID) — enables true background push notifications: the service
    // worker fires a system notification from a server-sent push event even when
    // no tab is open. Both keys are required together to enable the feature;
    // unset = push disabled (the dashboard falls back to in-tab alerts only).
    // Generate a pair with `node scripts/generate-vapid-keys.mjs`. The public key
    // is handed to the browser (via the push tRPC router) to create a
    // subscription; the private key signs the pushes and must stay server-side.
    WEB_PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
    WEB_PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
    // VAPID "subject": a mailto: or https: URL identifying the app to push
    // services (some require it). Defaults to a placeholder mailto.
    WEB_PUSH_CONTACT: z.string().default("mailto:admin@bandolier.local"),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // Slug of the Bandolier GitHub App (the `…/apps/<slug>` part of its public
    // page). When set, the repo-config UI links straight to the App's install
    // page; unset = the UI shows generic install guidance instead.
    NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().optional(),
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
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET,
    BANDOLIER_GITHUB_TOKEN: process.env.BANDOLIER_GITHUB_TOKEN,
    APP_PASSWORD: process.env.APP_PASSWORD,
    ARTIFACTS_S3_BUCKET: process.env.ARTIFACTS_S3_BUCKET,
    ARTIFACTS_S3_REGION: process.env.ARTIFACTS_S3_REGION,
    ARTIFACTS_S3_ENDPOINT: process.env.ARTIFACTS_S3_ENDPOINT,
    ARTIFACTS_AWS_ACCESS_KEY_ID: process.env.ARTIFACTS_AWS_ACCESS_KEY_ID,
    ARTIFACTS_AWS_SECRET_ACCESS_KEY:
      process.env.ARTIFACTS_AWS_SECRET_ACCESS_KEY,
    WEB_PUSH_VAPID_PUBLIC_KEY: process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY: process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_CONTACT: process.env.WEB_PUSH_CONTACT,
    NEXT_PUBLIC_GITHUB_APP_SLUG: process.env.NEXT_PUBLIC_GITHUB_APP_SLUG,
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
