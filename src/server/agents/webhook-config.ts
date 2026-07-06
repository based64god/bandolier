import { eq } from "drizzle-orm";

import { repoArtifactStore } from "~/server/agents/artifacts";
import { type AwsCredentials } from "~/server/agents/aws";
import { type db } from "~/server/db";
import { repoWebhookConfig } from "~/server/db/schema";

export interface RepoWebhookConfig {
  /** Trigger phrase events must contain; null means act on all events. */
  prefix: string | null;
  /** Agent harness image override; null means use the server-wide default. */
  agentImage: string | null;
  /** Default model id for webhook-triggered agents; null means provider default. */
  defaultWebhookModel: string | null;
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

/** Returns a repo's config (prefix + agent image + default model), or null. */
export async function getRepoWebhookConfig(
  database: typeof db,
  repoFullName: string,
): Promise<RepoWebhookConfig | null> {
  const row = await loadRepoConfig(database, repoFullName);
  if (!row) return null;
  return {
    prefix: row.prefix ?? null,
    agentImage: row.agentImage ?? null,
    defaultWebhookModel: row.defaultWebhookModel ?? null,
    defaultWebhookEffort: row.defaultWebhookEffort ?? null,
    systemPrompt: row.systemPrompt ?? null,
    resumeOnCiFailure: row.resumeOnCiFailure,
    hasArtifactStore: repoArtifactStore(row) !== null,
    networkPolicy: {
      allowPrivateEgress: row.allowPrivateEgress,
      allowAllPortsEgress: row.allowAllPortsEgress,
      policyYaml: row.networkPolicyYaml ?? null,
    },
  };
}
