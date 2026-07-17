import { eq } from "drizzle-orm";

import { repoArtifactStore } from "~/server/agents/artifacts";
import { type AwsCredentials } from "~/server/agents/aws";
import { type db } from "~/server/db";
import { repoWebhookConfig } from "~/server/db/schema";

export interface RepoWebhookConfig {
  /**
   * Trigger phrase events must contain; null means webhook events never
   * trigger agents (unless `triggerOnAllEvents` opts into everything).
   */
  prefix: string | null;
  /**
   * When true, webhook events always trigger agents, ignoring the prefix.
   * Off by default — see `shouldTriggerOnEvent`.
   */
  triggerOnAllEvents: boolean;
  /** Agent harness image override; null means use the server-wide default. */
  agentImage: string | null;
  /** Default model id for webhook-triggered agents; null means provider default. */
  defaultWebhookModel: string | null;
  /**
   * Model id for PR-review runs specifically; null falls back to
   * `defaultWebhookModel`, then the provider default. Lets a repo review with a
   * different model than it writes code with.
   */
  reviewModel: string | null;
  /**
   * Default reasoning-effort level for webhook-triggered Claude agents
   * (low|medium|high|xhigh|max); null means the CLI default. Ignored for
   * non-Claude providers. An issue's `effort:<level>` label overrides it.
   */
  defaultWebhookEffort: string | null;
  /**
   * Repo-attached system prompt appended to every agent run for this repo; null
   * means no repo-wide prompt.
   */
  systemPrompt: string | null;
  /**
   * Whether a failing CI pipeline on a PR should auto-resume the run that
   * produced its branch (the webhook's `workflow_run` handler). Off by default.
   */
  resumeOnCiFailure: boolean;
  /**
   * Whether a pull request opened (or marked ready for review) in this repo
   * gets an automatic Bandolier code review, posted in the bot voice. Off by
   * default — opt-in, admin-only. A later push to the PR branch re-reviews.
   */
  reviewPullRequests: boolean;
  /**
   * Whether the repo has a fully-configured artifact store (bucket + both
   * credential halves — see `repoArtifactStore`). Resuming a run requires it:
   * without a store no parent transcript was persisted, so a "resumed" run
   * would start with none of the context it claims to continue.
   */
  hasArtifactStore: boolean;
  /** Per-repo network-policy egress toggles. See `RepoNetworkPolicy`. */
  networkPolicy: RepoNetworkPolicy;
}

/**
 * Per-repo agent NetworkPolicy configuration (admin-only): egress-loosening
 * toggles (both default off, preserving the locked-down baseline) and,
 * advanced, a raw custom policy YAML that replaces the built-in policy —
 * toggles included — entirely.
 */
export interface RepoNetworkPolicy {
  /** Allow egress to private / in-cluster (RFC-1918) ranges. */
  allowPrivateEgress: boolean;
  /** Allow egress on any TCP port instead of only 80/443. */
  allowAllPortsEgress: boolean;
  /** Raw custom NetworkPolicy YAML (validated on save); null = built-in policy. */
  policyYaml: string | null;
}

/**
 * Repo-scoped credentials (admin-only): shared infrastructure that agents for
 * this repo can run on. Each field is null when not configured. The
 * `preferRepoCredentials` flag decides whether these or a user's own
 * credentials win when both are set.
 */
export interface RepoCredentials {
  kubeconfig: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  geminiApiKey: string | null;
  aws: AwsCredentials | null;
  preferRepoCredentials: boolean;
}

/** The full repo-config row, or null when the repo has no config row. */
export type RepoConfigRow = typeof repoWebhookConfig.$inferSelect;

/**
 * Loads a repo's config row in a single query — the one source every repo-config
 * accessor (credentials, webhook config, artifact store, compute) shapes its
 * result from. Callers that need only a slice of the row still read it through
 * here, so the near-identical per-field selects that used to be spread across
 * these modules are gone. Returns null when the repo has no config row.
 */
export async function loadRepoConfig(
  database: typeof db,
  repoFullName: string,
): Promise<RepoConfigRow | null> {
  const [row] = await database
    .select()
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, repoFullName))
    .limit(1);
  return row ?? null;
}

/** Shapes a config row into a repo's shared credentials (pure). */
export function repoCredentials(row: RepoConfigRow): RepoCredentials {
  // AWS creds are only usable as a set — require at least the key id + secret.
  const aws: AwsCredentials | null =
    row.awsAccessKeyId && row.awsSecretAccessKey
      ? {
          accessKeyId: row.awsAccessKeyId,
          secretAccessKey: row.awsSecretAccessKey,
          sessionToken: row.awsSessionToken,
          region: row.awsRegion ?? "us-east-1",
        }
      : null;

  return {
    kubeconfig: row.kubeconfig ?? null,
    anthropicApiKey: row.anthropicApiKey ?? null,
    openaiApiKey: row.openaiApiKey ?? null,
    geminiApiKey: row.geminiApiKey ?? null,
    aws,
    preferRepoCredentials: row.preferRepoCredentials,
  };
}

/** Loads a repo's shared credentials, or null when no config row exists. */
export async function getRepoCredentials(
  database: typeof db,
  repoFullName: string,
): Promise<RepoCredentials | null> {
  const row = await loadRepoConfig(database, repoFullName);
  return row ? repoCredentials(row) : null;
}

/**
 * Whether a webhook event's text should trigger an agent. The default is
 * never: a repo must opt in, either with a trigger phrase the text has to
 * contain, or with `triggerOnAllEvents`, which fires on everything and
 * ignores the phrase. A repo with no config row (null) never triggers.
 */
export function shouldTriggerOnEvent(
  config: Pick<RepoWebhookConfig, "prefix" | "triggerOnAllEvents"> | null,
  text: string,
): boolean {
  if (config?.triggerOnAllEvents) return true;
  return !!config?.prefix && text.includes(config.prefix);
}

/** Returns a repo's config (prefix + agent image + default model), or null. */
export async function getRepoWebhookConfig(
  database: typeof db,
  repoFullName: string,
): Promise<RepoWebhookConfig | null> {
  const row = await loadRepoConfig(database, repoFullName);
  if (!row) return null;
  return {
    prefix: row.prefix ?? null,
    triggerOnAllEvents: row.triggerOnAllEvents,
    agentImage: row.agentImage ?? null,
    defaultWebhookModel: row.defaultWebhookModel ?? null,
    reviewModel: row.reviewModel ?? null,
    defaultWebhookEffort: row.defaultWebhookEffort ?? null,
    systemPrompt: row.systemPrompt ?? null,
    resumeOnCiFailure: row.resumeOnCiFailure,
    reviewPullRequests: row.reviewPullRequests,
    hasArtifactStore: repoArtifactStore(row) !== null,
    networkPolicy: {
      allowPrivateEgress: row.allowPrivateEgress,
      allowAllPortsEgress: row.allowAllPortsEgress,
      policyYaml: row.networkPolicyYaml ?? null,
    },
  };
}
