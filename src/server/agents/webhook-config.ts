import { eq } from "drizzle-orm";

import { type AwsCredentials } from "~/server/agents/aws";
import { type EgressPolicy } from "~/server/agents/create-job";
import { type db } from "~/server/db";
import { repoWebhookConfig } from "~/server/db/schema";

export interface RepoWebhookConfig {
  /** Trigger phrase events must contain; null means act on all events. */
  prefix: string | null;
  /** Agent harness image override; null means use the server-wide default. */
  agentImage: string | null;
  /** Default model id for webhook-triggered agents; null means provider default. */
  defaultWebhookModel: string | null;
  /** Whether agents may reach the public internet (model providers, GitHub). */
  allowPublicEgress: boolean;
  /** SECURITY: whether agents may reach the cluster's own private ranges. */
  allowPrivateEgress: boolean;
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

/** Loads a repo's shared credentials, or null when no config row exists. */
export async function getRepoCredentials(
  database: typeof db,
  repoFullName: string,
): Promise<RepoCredentials | null> {
  const [row] = await database
    .select({
      kubeconfig: repoWebhookConfig.kubeconfig,
      anthropicApiKey: repoWebhookConfig.anthropicApiKey,
      openaiApiKey: repoWebhookConfig.openaiApiKey,
      geminiApiKey: repoWebhookConfig.geminiApiKey,
      awsAccessKeyId: repoWebhookConfig.awsAccessKeyId,
      awsSecretAccessKey: repoWebhookConfig.awsSecretAccessKey,
      awsSessionToken: repoWebhookConfig.awsSessionToken,
      awsRegion: repoWebhookConfig.awsRegion,
      preferRepoCredentials: repoWebhookConfig.preferRepoCredentials,
    })
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, repoFullName))
    .limit(1);
  if (!row) return null;

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

/** Returns a repo's config (prefix + agent image + default model), or null. */
export async function getRepoWebhookConfig(
  database: typeof db,
  repoFullName: string,
): Promise<RepoWebhookConfig | null> {
  const [row] = await database
    .select({
      prefix: repoWebhookConfig.prefix,
      agentImage: repoWebhookConfig.agentImage,
      defaultWebhookModel: repoWebhookConfig.defaultWebhookModel,
      allowPublicEgress: repoWebhookConfig.allowPublicEgress,
      allowPrivateEgress: repoWebhookConfig.allowPrivateEgress,
    })
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, repoFullName))
    .limit(1);
  if (!row) return null;
  return {
    prefix: row.prefix ?? null,
    agentImage: row.agentImage ?? null,
    defaultWebhookModel: row.defaultWebhookModel ?? null,
    allowPublicEgress: row.allowPublicEgress,
    allowPrivateEgress: row.allowPrivateEgress,
  };
}

/**
 * A repo's network-policy egress toggles, used to parameterize the agent
 * isolation NetworkPolicy at deploy time. Falls back to the safe baseline
 * (public allowed, private blocked) when the repo has no config row.
 */
export async function getRepoEgressPolicy(
  database: typeof db,
  repoFullName: string,
): Promise<EgressPolicy> {
  const [row] = await database
    .select({
      allowPublicEgress: repoWebhookConfig.allowPublicEgress,
      allowPrivateEgress: repoWebhookConfig.allowPrivateEgress,
    })
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, repoFullName))
    .limit(1);
  return {
    allowPublicEgress: row?.allowPublicEgress ?? true,
    allowPrivateEgress: row?.allowPrivateEgress ?? false,
  };
}

/**
 * The agent harness image to use for a repo: its configured override, or null
 * when none is set (callers fall back to the built-in DEFAULT_HARNESS_IMAGE).
 */
export async function getRepoAgentImage(
  database: typeof db,
  repoFullName: string,
): Promise<string | null> {
  const [row] = await database
    .select({ agentImage: repoWebhookConfig.agentImage })
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, repoFullName))
    .limit(1);
  return row?.agentImage ?? null;
}

/**
 * Whether the user (via their GitHub token) has admin on the repo. Gates the
 * repo-scoped configuration (trigger prefix, agent image, shared credentials).
 * Returns false on any API error so callers fail closed.
 */
export async function isRepoAdmin(
  token: string,
  repoFullName: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return false;
    const repo = (await res.json()) as { permissions?: { admin?: boolean } };
    return repo.permissions?.admin === true;
  } catch {
    return false;
  }
}
