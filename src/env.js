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
    // Optional shared password gate in front of the whole app (UI + API). When
    // set, visitors must enter it before reaching anything (the GitHub webhook
    // is exempt — it authenticates via signature). Unset = gate disabled.
    APP_PASSWORD: z.string().optional(),
    // ── Web Push (VAPID) ──────────────────────────────────────────────────────
    // Keys for signing background push notifications, so a user is alerted when
    // their agent finishes even with the app closed. Generate a pair with
    // `pnpm vapid:generate`; the public half is exposed to the client below.
    // VAPID_SUBJECT identifies the sender to push services (a mailto: or https:
    // URL). All three are required together to enable push; unset = push
    // notifications are skipped (foreground in-tab alerts still work).
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().optional(),
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
    // The VAPID public key, used as the `applicationServerKey` when the browser
    // subscribes to push. Must match VAPID_PRIVATE_KEY above; unset = the client
    // never attempts a push subscription.
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
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
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET,
    APP_PASSWORD: process.env.APP_PASSWORD,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    NEXT_PUBLIC_GITHUB_APP_SLUG: process.env.NEXT_PUBLIC_GITHUB_APP_SLUG,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
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
