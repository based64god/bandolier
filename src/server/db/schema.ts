import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  pgTableCreator,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `pg-drizzle_${name}`);

export const posts = createTable(
  "post",
  (d) => ({
    id: d.integer().primaryKey().generatedByDefaultAsIdentity(),
    name: d.varchar({ length: 256 }),
    createdById: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => user.id),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [
    index("created_by_idx").on(t.createdById),
    index("name_idx").on(t.name),
  ],
);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
  updatedAt: timestamp("updated_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
});

export const userAwsCredentials = pgTable("user_aws_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  accessKeyId: text("access_key_id").notNull(),
  secretAccessKey: text("secret_access_key").notNull(),
  sessionToken: text("session_token"),
  region: text("region").notNull().default("us-east-1"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

// Durable record of an agent run, surviving the Job's TTL. Artifacts (the
// transcript now; workspace/session later) live in object storage; columns hold
// pointers + metadata so runs can be listed and inspected after the pod is gone.
export const taskRun = pgTable("task_run", {
  jobName: text("job_name").primaryKey(),
  namespace: text("namespace").notNull(),
  displayName: text("display_name").notNull(),
  createdBy: text("created_by"),
  repoFullName: text("repo_full_name"),
  issueNumber: text("issue_number"),
  /** Object-storage key for the rendered transcript, set on harness callback. */
  transcriptKey: text("transcript_key"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

// Queued user input for interactive agents. The dashboard enqueues a row; the
// harness (which can't hold a session) polls the input endpoint, drains the
// oldest undelivered row for its job, and feeds it to Claude as the next turn.
export const agentInput = pgTable(
  "agent_input",
  {
    id: text("id").primaryKey(),
    jobName: text("job_name").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    /** Set once the harness has fetched this row, so it's delivered exactly once. */
    deliveredAt: timestamp("delivered_at"),
  },
  (t) => [index("agent_input_job_idx").on(t.jobName)],
);

// Per-repository configuration (one row per repo, shared across any Bandolier
// user with admin on that repo). Holds the webhook trigger prefix plus other
// repo-level settings such as the agent harness image and shared credentials.
// Webhook delivery + signature verification is handled by the GitHub App at the
// app level (one GITHUB_WEBHOOK_SECRET), so no per-repo secret lives here.
export const repoWebhookConfig = pgTable("repo_webhook_config", {
  repoFullName: text("repo_full_name").primaryKey(),
  // Optional trigger phrase: when set, only webhook events whose text contains
  // it are acted on. Null = act on all events.
  prefix: text("prefix"),
  // Optional override for the agent harness container image used by agents run
  // for this repo. Null = use the built-in DEFAULT_HARNESS_IMAGE.
  agentImage: text("agent_image"),
  // Optional default model id for webhook-triggered agents (e.g. issue-opened).
  // Null = fall back to the provider's default. An issue's `model:<query>` label
  // overrides this per issue.
  defaultWebhookModel: text("default_webhook_model"),
  // ── Repo-scoped credentials (admin-only) ──────────────────────────────────
  // Shared infrastructure for everyone working on this repo: a kubeconfig the
  // repo's agents run on and model credentials they authenticate with. Only a
  // repo admin can set these. A server-wide kubeconfig still overrides the
  // repo's. SECURITY: these are shared across every Bandolier user with access
  // to the repo, so the cluster/keys must be scoped to what that group should
  // be trusted with — see the warning surfaced in the repo config UI.
  kubeconfig: text("kubeconfig"),
  anthropicApiKey: text("anthropic_api_key"),
  openaiApiKey: text("openai_api_key"),
  geminiApiKey: text("gemini_api_key"),
  awsAccessKeyId: text("aws_access_key_id"),
  awsSecretAccessKey: text("aws_secret_access_key"),
  awsSessionToken: text("aws_session_token"),
  awsRegion: text("aws_region"),
  // When both a user and this repo have credentials of the same kind, this
  // decides which wins. False (default) prefers the user's own; true prefers
  // the repo's shared credentials.
  preferRepoCredentials: boolean("prefer_repo_credentials")
    .notNull()
    .default(false),
  configuredBy: text("configured_by").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

export const userAnthropicCredentials = pgTable("user_anthropic_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  apiKey: text("api_key").notNull(),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

export const userOpenaiCredentials = pgTable("user_openai_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  apiKey: text("api_key").notNull(),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

export const userGeminiCredentials = pgTable("user_gemini_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  apiKey: text("api_key").notNull(),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

// User-provisioned API keys. The full token is shown once at creation and only
// its SHA-256 hash is stored; a request bearing a valid key acts as its owner
// with that user's exact permissions.
export const apiKey = pgTable("api_key", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // First few chars of the token, kept for display so a user can tell keys apart.
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const userKubeconfig = pgTable("user_kubeconfig", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  kubeconfig: text("kubeconfig").notNull(),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

// Where the Bandolier GitHub App is installed. One row per repo the App can act
// on; the bot's installation access token (for issue/PR comments and other
// bot-voice actions) is minted on demand from the App key + this installationId.
// Rows are maintained by the App's `installation` / `installation_repositories`
// webhook events: added on install/added, removed on uninstall/removed. This is
// distinct from per-user OAuth tokens, which remain the source of attribution.
export const githubInstallation = pgTable("github_installation", {
  repoFullName: text("repo_full_name").primaryKey(),
  // GitHub's numeric installation id; the unit a bot token is scoped to. Stored
  // as text for parity with the other GitHub ids kept as text (account.accountId).
  installationId: text("installation_id").notNull(),
  // The account (org or user login) the App is installed under, for display and
  // debugging; not used for token minting.
  accountLogin: text("account_login"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
    .notNull(),
});

// A webhook-triggered run that would execute with repo-level shared credentials
// (a repo kubeconfig or repo AI API keys) but was opened by a GitHub user who
// lacks maintainer access. Rather than run it, the bot leaves a comment asking a
// maintainer to approve; this row holds everything needed to dispatch the agent
// once a maintainer does (by reacting to that comment or replying to approve).
// Rows are deleted once dispatched or denied.
export const pendingApproval = pgTable(
  "pending_approval",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: text("issue_number").notNull(),
    issueUrl: text("issue_url").notNull(),
    issueTitle: text("issue_title").notNull(),
    issueBody: text("issue_body"),
    // JSON-encoded array of issue label names, preserved so the model:<query>
    // and output:issue label semantics still apply when the run is dispatched.
    issueLabels: text("issue_labels").notNull().default("[]"),
    cloneUrl: text("clone_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    // The GitHub account that opened the issue (numeric id, as text) and its
    // login — used to re-resolve the Bandolier user whose credentials run it.
    requestedByGithubId: text("requested_by_github_id").notNull(),
    requestedByLogin: text("requested_by_login").notNull(),
    // The id of the bot comment whose reactions signal a maintainer's approval.
    commentId: text("comment_id"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (t) => [
    index("pending_approval_repo_issue_idx").on(t.repoFullName, t.issueNumber),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  account: many(account),
  session: many(session),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));
