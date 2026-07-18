import { relations } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

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
  /**
   * Canonical id of the user who spawned this run, used to authorize ownership of
   * the run after its pod is gone (e.g. serving the persisted transcript). Unlike
   * `createdBy` (a display name/login for UI), this is the stable session user id
   * and must never be returned to clients. Null for runs created before this
   * column existed.
   */
  spawnedBy: text("spawned_by"),
  repoFullName: text("repo_full_name"),
  issueNumber: text("issue_number"),
  /**
   * Job name of the run this one resumes (e.g. a follow-up comment on the
   * parent's issue or pull request). The resumed run is seeded with the
   * parent's persisted transcript as context, and the UI surfaces the lineage.
   * Null for runs that aren't resumptions.
   */
  parentJobName: text("parent_job_name"),
  /**
   * Head commit SHA of the pull request whose CI failure auto-resumed this run
   * (see the webhook's `workflow_run` handler). Recorded so the handler can
   * both de-duplicate redelivered / multi-workflow failure events for the same
   * commit and cap how many times a single PR auto-resumes, preventing an
   * endless resume→push→fail→resume loop. Null for every non-CI-triggered run.
   */
  ciResumeSha: text("ci_resume_sha"),
  /** Object-storage key for the rendered transcript, set on harness callback. */
  transcriptKey: text("transcript_key"),
  /**
   * The run's terminal state ("Succeeded" | "Failed"), reported by the harness
   * ingest callback. The pod's phase is the live source while the pod exists;
   * this keeps the outcome for the persisted task list after the Job's TTL
   * deletes it. Null until the callback arrives (or for runs whose harness
   * predates status reporting).
   */
  status: text("status"),
  /**
   * The run's durable output, reported by the harness ingest callback. Pod logs
   * are the live source while the pod exists, but they vanish with the pod (TTL
   * deletion, eviction, node loss); persisting the URLs here keeps a finished
   * run's output recoverable regardless of cluster state.
   */
  pullRequestUrl: text("pull_request_url"),
  createdIssueUrl: text("created_issue_url"),
  /**
   * For a review run (outputType "review"), the html_url of the pull request it
   * reviews — its *input*, recorded at creation time (unlike pullRequestUrl /
   * createdIssueUrl, which the harness reports as a run's produced output). A
   * non-null value is what marks a run as a review: it lets a comment-resume
   * skip review runs when picking the coding task to resume, and lets a push to
   * the PR branch (`pull_request` synchronize) find the review run to re-review.
   * Null for every non-review run.
   */
  reviewedPrUrl: text("reviewed_pr_url"),
  /**
   * For a review run, whether its review is posted in the acting user's voice
   * (their GitHub token) rather than the bandolier[bot] voice. Dashboard-created
   * reviews are user-attributed (true); webhook-triggered reviews are bot-voice
   * (false). Read by the review-submit endpoint to pick which token posts. Null
   * for non-review runs.
   */
  reviewAsUser: boolean("review_as_user"),
  /**
   * For a review run, the numeric GitHub id of the review it posted, recorded
   * when the review-submit endpoint posts it. Lets the webhook layer skip
   * resuming on the inline comments that review generated (a user-attributed
   * review's comments are authored by a real user, so the bot-login filter
   * wouldn't catch them). Null until a review is posted (or for non-review runs).
   */
  postedReviewId: text("posted_review_id"),
  /**
   * The run's cumulative token usage, reported by the harness ingest callback
   * (parsed from the agent CLI's result event). Like the output URLs, pod logs
   * are the live source while the pod exists, but persisting it here keeps a
   * finished run's token readout recoverable after the pod is gone. Null until
   * the run reports usage (or for providers that don't report tokens).
   */
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadInputTokens: integer("cache_read_input_tokens"),
  cacheCreationInputTokens: integer("cache_creation_input_tokens"),
  /**
   * The harness container image the run's pod ran on (the repo's custom
   * agentImage, or the built-in default), recorded at deploy time. Lets the
   * staleness check attribute a run's reported contract version to the image
   * currently configured — a repo that just fixed its image reference stops
   * matching old runs immediately. Null for runs predating this column.
   */
  agentImage: text("agent_image"),
  /**
   * The server↔harness contract version the run's harness reported on the
   * ingest callback (see wire-contract.json). 0 = the callback arrived without
   * the header, i.e. a harness built before version reporting — certainly out
   * of date. Null = no callback yet (run in flight, pod lost before upload, or
   * a run predating this column), which says nothing about the image.
   */
  harnessContract: integer("harness_contract"),
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

// Ordered log of Agent Client Protocol (ACP) frames relayed between an
// interactive session's frontend (the ACP client) and the in-pod agent (the ACP
// server), with the harness proxying between this table and the agent's stdio.
// Each row is one raw JSON-RPC frame. `direction` is "c2a" (client→agent:
// initialize/session.new/prompt/cancel and Bandolier control frames) or "a2c"
// (agent→client: session/update notifications, responses, permission requests).
// The monotonic `seq` doubles as the cursor the frontend polls by; c2a rows are
// claimed exactly once by the harness via `deliveredAt`, like agent_input.
export const acpFrame = pgTable(
  "acp_frame",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    jobName: text("job_name").notNull(),
    direction: text("direction").notNull(),
    payload: text("payload").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    /** Set once the harness has claimed a c2a frame, so it's delivered once. */
    deliveredAt: timestamp("delivered_at"),
  },
  (t) => [index("acp_frame_job_dir_idx").on(t.jobName, t.direction)],
);

// Per-repository configuration (one row per repo, shared across any Bandolier
// user with admin on that repo). Holds the webhook trigger prefix plus other
// repo-level settings such as the agent harness image and shared credentials.
// Webhook delivery + signature verification is handled by the GitHub App at the
// app level (one GITHUB_WEBHOOK_SECRET), so no per-repo secret lives here.
export const repoWebhookConfig = pgTable("repo_webhook_config", {
  repoFullName: text("repo_full_name").primaryKey(),
  // Optional trigger phrase: when set, only webhook events whose text contains
  // it are acted on. Null = webhook events never trigger agents, unless
  // triggerOnAllEvents opts the repo into firing on everything.
  prefix: text("prefix"),
  // When true, webhook events always trigger agents, ignoring the prefix
  // entirely. Off by default: a repo must opt in — by phrase or by this
  // toggle — before events spend anyone's credentials.
  triggerOnAllEvents: boolean("trigger_on_all_events").notNull().default(false),
  // Optional override for the agent harness container image used by agents run
  // for this repo. Null = use the built-in DEFAULT_HARNESS_IMAGE.
  agentImage: text("agent_image"),
  // Optional default model id for webhook-triggered agents (e.g. issue-opened).
  // Null = fall back to the provider's default. An issue's `model:<query>` label
  // overrides this per issue.
  defaultWebhookModel: text("default_webhook_model"),
  // Optional default reasoning-effort level for webhook-triggered agents on Claude
  // models (low|medium|high|xhigh|max). Null = the harness/CLI default. An issue's
  // `effort:<level>` label overrides this per issue. Ignored for non-Claude
  // providers (OpenAI/Gemini), whose CLIs don't take an effort flag.
  defaultWebhookEffort: text("default_webhook_effort"),
  // Optional default compute (CPU / memory limit) for agents run for this repo,
  // as Kubernetes quantities (e.g. "4"/"4Gi"). Applies to every run for the
  // repo (dashboard, issue, and webhook) the way agentImage does; ordered
  // against the user's own default by preferRepoCredentials, and overridden
  // per task by the deploy form or an issue's `cpu:<qty>` / `memory:<qty>`
  // label. Null = fall through to the user default, then the built-in limit.
  computeCpu: text("compute_cpu"),
  computeMemory: text("compute_memory"),
  // Optional repo-attached system prompt: a blanket instruction appended to the
  // system prompt of every agent run for this repo (dashboard, issue, and
  // webhook; all providers and modes), letting admins set repo-wide guidance —
  // coding conventions, review checklists, etc. — without repeating it per task.
  // It is layered on top of the harness's own framing, never replacing it. Null
  // = no repo-wide prompt.
  systemPrompt: text("system_prompt"),
  // When true, a failing CI pipeline on a pull request whose head branch a
  // Bandolier run produced auto-resumes that run so the agent can investigate
  // and push a fix — the same resume flow a human comment triggers, but driven
  // by the `workflow_run` webhook instead. Off by default: opt-in, since it
  // spends the run owner's credentials without a human in the loop. The
  // handler bounds itself (one resume per failing commit, capped per PR) to
  // avoid an endless resume→push→fail loop.
  resumeOnCiFailure: boolean("resume_on_ci_failure").notNull().default(false),
  // When true, a pull request opened (or marked ready for review) in this repo
  // gets an automatic Bandolier code review: a read-only agent analyses the PR
  // and the review is posted in the bandolier[bot] voice (never the triggering
  // user's credentials). Off by default — opt-in, like every other repo setting,
  // and only a repo admin can turn it on. A subsequent push to the PR's branch
  // (`pull_request` synchronize) resumes that review to re-review the changes.
  reviewPullRequests: boolean("review_pull_requests").notNull().default(false),
  // Optional model id used specifically for PR-review runs, separate from
  // defaultWebhookModel (which serves issue/comment runs). Null = fall back to
  // defaultWebhookModel, then the provider default. Lets a repo review with a
  // cheaper/stronger model than it uses to write code.
  reviewModel: text("review_model"),
  // ── Repo-scoped credentials (admin-only) ──────────────────────────────────
  // Shared infrastructure for everyone working on this repo: a kubeconfig the
  // repo's agents run on and model credentials they authenticate with. Only a
  // repo admin can set these. SECURITY: these are shared across every
  // Bandolier user with access to the repo, so the cluster/keys must be scoped
  // to what that group should be trusted with — see the warning surfaced in
  // the repo config UI.
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
  // ── Run artifact storage (admin-only) ─────────────────────────────────────
  // Repo-owned object storage for persisted run artifacts (transcripts now;
  // historical context later). This is the only artifact store — there is
  // deliberately no server-wide bucket — so the repo, not the Bandolier
  // operator, owns its run data; runs for repos without one (and repo-less
  // runs) simply aren't persisted. Credentials are dedicated to the artifact
  // store on purpose: they're server-side only (never injected into agent
  // pods, unlike the Bedrock credentials above) and should be scoped to just
  // this bucket.
  artifactsS3Bucket: text("artifacts_s3_bucket"),
  artifactsS3Region: text("artifacts_s3_region"),
  // Custom endpoint for MinIO / S3-compatible stores; null = AWS S3.
  artifactsS3Endpoint: text("artifacts_s3_endpoint"),
  artifactsAccessKeyId: text("artifacts_access_key_id"),
  artifactsSecretAccessKey: text("artifacts_secret_access_key"),
  // ── Network policy egress toggles (admin-only) ─────────────────────────────
  // Per-repo loosenings of the default agent NetworkPolicy egress rules. Each
  // widens what this repo's agent pods can reach and is OFF by default, keeping
  // the locked-down baseline (deny inbound; egress only to DNS + the public
  // internet on 80/443, with in-cluster private ranges blocked). Turning one on
  // trades isolation for reach, so the repo-config UI surfaces a security
  // warning. Only meaningful when AGENT_NETWORK_POLICY is enabled and the
  // cluster runs a policy-enforcing CNI (Calico/Cilium). SECURITY: see the
  // warning surfaced in the repo config UI.
  //
  // Allow egress to private / in-cluster (RFC-1918) ranges — drops the
  // AGENT_EGRESS_BLOCKED_CIDRS exclusion, letting agents reach other pods and
  // in-cluster services (lateral-movement risk).
  allowPrivateEgress: boolean("allow_private_egress").notNull().default(false),
  // Allow egress on any TCP port instead of only 80/443 — widens the
  // exfiltration / arbitrary-protocol surface.
  allowAllPortsEgress: boolean("allow_all_ports_egress")
    .notNull()
    .default(false),
  // Advanced: raw NetworkPolicy YAML that replaces the built-in agent policy —
  // and with it both toggles above — entirely for this repo's namespaces.
  // Validated structurally on save (see validateNetworkPolicyYaml); its
  // metadata is overridden to the managed policy name/namespace at apply time.
  // Null = use the built-in policy with the toggles.
  networkPolicyYaml: text("network_policy_yaml"),
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
  // Exactly one of apiKey / oauthToken is set: a row holds either an Anthropic
  // API key or a Claude subscription OAuth token from `claude setup-token`
  // (sk-ant-oat01-…, injected into agents as CLAUDE_CODE_OAUTH_TOKEN).
  apiKey: text("api_key"),
  oauthToken: text("oauth_token"),
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
  // Exactly one of apiKey / codexAuthJson is set: a row holds either an OpenAI
  // API key or the contents of `codex login`'s ~/.codex/auth.json for
  // ChatGPT-subscription auth (injected into agents as CODEX_AUTH_JSON).
  apiKey: text("api_key"),
  codexAuthJson: text("codex_auth_json"),
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

// Credentials for the model providers served through the harness's embedded
// gollm proxy (everything beyond Anthropic/Bedrock/OpenAI/Gemini): one row per
// (user, provider). `provider` is gollm's canonical name and must exist in the
// provider catalog (~/server/agents/gollm-catalog); the row's fields map onto
// the env vars gollm reads inside the pod.
export const userCustomProviderCredentials = pgTable(
  "user_custom_provider_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** gollm provider id ("groq", "openrouter", "github_copilot", …). */
    provider: text("provider").notNull(),
    /** API key / token, mapped to the provider's conventional env var. */
    apiKey: text("api_key"),
    /** Endpoint override (required for self-hosted backends). */
    apiBase: text("api_base"),
    /**
     * Extra env vars (JSON object) for providers that need more than a key +
     * endpoint (OCI's identity fields, watsonx's project id, …). Injected
     * into the pod verbatim alongside the mapped key/endpoint.
     */
    extraEnv: text("extra_env"),
    /**
     * Optional model ids (JSON string array) shown in the picker — the source
     * for providers without an OpenAI-compatible GET /models, and a fallback
     * when the listing call fails.
     */
    models: text("models"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [unique().on(t.userId, t.provider)],
);

// The repo-shared counterpart of user_custom_provider_credentials: gollm-proxied
// provider credentials scoped to a repo (admin-only), one row per (repo,
// provider). Mirrors how the repoWebhookConfig columns hold the shared
// Anthropic/OpenAI/Gemini/Bedrock credentials — the prefer-repo-credentials flag
// there decides these vs a user's own. Keyed by repo full name (not an FK) so it
// stands alone from the config row.
export const repoCustomProviderCredentials = pgTable(
  "repo_custom_provider_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    repoFullName: text("repo_full_name").notNull(),
    /** gollm provider id ("groq", "openrouter", "github_copilot", …). */
    provider: text("provider").notNull(),
    /** API key / token, mapped to the provider's conventional env var. */
    apiKey: text("api_key"),
    /** Endpoint override (required for self-hosted backends). */
    apiBase: text("api_base"),
    /** Extra env vars (JSON object) injected into the pod verbatim. */
    extraEnv: text("extra_env"),
    /** Optional model ids (JSON string array) shown in the picker. */
    models: text("models"),
    /** The repo admin who last configured this shared credential. */
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
  },
  (t) => [unique().on(t.repoFullName, t.provider)],
);

// Records when a user last ran an agent on each model provider, so the
// dashboard footer can surface the credentials that have been used recently.
// `provider` is the canonical run-provider name — one of the four first-class
// providers ("bedrock"/"anthropic"/"openai"/"gemini") or a gollm-proxied one as
// "gollm:<id>" — so the indicator covers every provider gollm supports. One row
// per (user, provider); each deploy upserts its row.
export const credentialUsage = pgTable(
  "credential_usage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    lastUsedAt: timestamp("last_used_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    // Which credential kind the most recent deploy routed through: "api_key"
    // (metered, pay-per-token) or "subscription" (a fixed rolling-window
    // allowance). The footer shows a "used …" timestamp for metered keys but a
    // "how close to maxed out" meter for subscriptions, whose runs are the
    // limited resource.
    authKind: text("auth_kind").notNull().default("api_key"),
    // The rolling usage window a subscription's allowance is counted over. Start
    // time of the current window; `windowRuns` counts the deploys since it. When
    // a deploy lands after the window has elapsed, both reset (see
    // recordCredentialUsage). Unused for metered keys.
    windowStartedAt: timestamp("window_started_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    windowRuns: integer("window_runs").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
);

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

// A user's default compute (CPU / memory limit) for the agents they deploy, as
// Kubernetes quantities. Resolved like the user kubeconfig: a repo's own
// default can win per its prefer-credentials flag, and a per-task override
// (deploy form, or issue `cpu:`/`memory:` labels) beats both. Either field may
// be null — set just a memory default and CPU falls through to the built-in.
export const userCompute = pgTable("user_compute", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  cpu: text("cpu"),
  memory: text("memory"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .$onUpdate(() => new Date())
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

// A one-click DigitalOcean agent-cluster deployment: the UI equivalent of the
// agent_only=true OpenTofu configuration under deploy/terraform/digitalocean.
// The row is the state machine's persistence: each client poll advances the
// deployment one idempotent step (create DOKS cluster → wait running → create
// Spaces bucket → mint bucket-scoped key → bootstrap a long-lived
// ServiceAccount kubeconfig → save it as the user's kubeconfig).
//
// The user's API token is NEVER persisted: it lives in the browser's memory
// and rides along on every tick/cancel request; the server uses it for the
// duration of the request only. Likewise the temporary full-access Spaces key
// used to create the bucket (the bucket API authenticates with Spaces keys,
// not the API token) is minted, used, and deleted within a single request.
// The only credentials on this row are the ones provisioned FOR the user —
// the bucket-scoped key secret and the generated kubeconfig — kept until the
// success screen is dismissed so they can be copied/inserted. Resource ids
// (cluster id, bucket name) are kept indefinitely: they are secret-free and
// feed the terraform adoption bundle (import blocks + tfvars) for day-2.
export const clusterDeployment = pgTable(
  "cluster_deployment",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // State-machine position: creating-cluster | waiting-cluster |
    // creating-bucket | creating-key | bootstrapping-kubeconfig | saving |
    // done | failed | dismissed. Non-terminal rows are advanced by polling;
    // at most one non-terminal row per user (enforced in code).
    status: text("status").notNull(),
    error: text("error"),
    // Requested shape; defaults mirror deploy/terraform/digitalocean/variables.tf.
    clusterName: text("cluster_name").notNull(),
    region: text("region").notNull(),
    nodeSize: text("node_size").notNull(),
    minNodes: integer("min_nodes").notNull(),
    maxNodes: integer("max_nodes").notNull(),
    haControlPlane: boolean("ha_control_plane").notNull().default(false),
    spacesEnabled: boolean("spaces_enabled").notNull(),
    // Provisioned resource identifiers (adoption-bundle inputs).
    clusterId: text("cluster_id"),
    k8sVersion: text("k8s_version"),
    bucketName: text("bucket_name"),
    // The bucket-scoped Spaces key minted for artifact storage. The access key
    // id doubles as the key's DO identifier; the secret is shown once on the
    // success screen and nulled on dismissal.
    spacesAccessKeyId: text("spaces_access_key_id"),
    spacesSecretAccessKey: text("spaces_secret_access_key"),
    // The generated ServiceAccount kubeconfig. NOT auto-saved: the success
    // screen offers copy / download / save-to-settings (with an overwrite
    // confirmation), and dismissal wipes it like the key secret.
    kubeconfig: text("kubeconfig"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("cluster_deployment_user_id_idx").on(t.userId)],
);

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

// A webhook-triggered agent run that is held for approval because it would run
// with repo-level credentials (a shared kubeconfig or shared model API key) but
// the GitHub user who opened the issue lacks the maintainer-or-higher privilege
// required to spend them. The bot leaves a comment on the issue; a maintainer+
// approves by reacting to (or replying to) that comment, at which point the
// stored payload is replayed and the agent is dispatched. Rows are one-shot: a
// dispatched (or declined) run is marked resolved so it can't fire twice.
export const pendingAgentRun = pgTable(
  "pending_agent_run",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    // The GitHub login of the (under-privileged) user who opened the issue, for
    // display in the bot comment and logging.
    requestedByLogin: text("requested_by_login").notNull(),
    // The id of the bot comment that asks a maintainer to approve. A reaction on
    // this comment (or a reply mentioning approval) dispatches the run.
    approvalCommentId: text("approval_comment_id"),
    // The full createAgentJob payload (JSON) to replay on approval. Holds the
    // resolved repo-level credentials, so this row is as sensitive as the config
    // it was derived from and is deleted once resolved.
    payload: text("payload").notNull(),
    // Set once the run has been dispatched or declined, so approval is one-shot.
    resolvedAt: timestamp("resolved_at"),
    // How it resolved: "dispatched" (a maintainer approved) or "declined".
    resolution: text("resolution"),
    // The GitHub login of the maintainer who approved, for the audit trail.
    resolvedByLogin: text("resolved_by_login"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (t) => [
    index("pending_agent_run_repo_issue_idx").on(t.repoFullName, t.issueNumber),
    index("pending_agent_run_comment_idx").on(t.approvalCommentId),
  ],
);

// A browser's Web Push subscription, so the server can alert a user that their
// agent finished even when the app is closed. One row per push endpoint (the
// natural key — a user with several browsers/devices has several rows). Rows are
// created when a user enables notifications and pruned when a push service
// reports the endpoint is gone (404/410) or the user disables notifications.
export const pushSubscription = pgTable(
  "push_subscription",
  {
    // The push service endpoint URL — unique per subscription, so it's the key.
    endpoint: text("endpoint").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The subscription's encryption keys, needed to sign each push payload.
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (t) => [index("push_subscription_user_idx").on(t.userId)],
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
