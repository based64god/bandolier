import { eq } from "drizzle-orm";

import { db } from "~/server/db";
import { repoWebhookConfig } from "~/server/db/schema";

export interface RepoWebhookConfig {
  /** Per-repo webhook secret; null means fall back to GITHUB_WEBHOOK_SECRET. */
  secret: string | null;
  /** Trigger phrase events must contain; null means act on all events. */
  prefix: string | null;
  /** Agent harness image override; null means use the server-wide default. */
  agentImage: string | null;
}

/** Returns a repo's config (secret + prefix + agent image), or null. */
export async function getRepoWebhookConfig(
  database: typeof db,
  repoFullName: string,
): Promise<RepoWebhookConfig | null> {
  const [row] = await database
    .select({
      secret: repoWebhookConfig.secret,
      prefix: repoWebhookConfig.prefix,
      agentImage: repoWebhookConfig.agentImage,
    })
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, repoFullName))
    .limit(1);
  if (!row) return null;
  return {
    secret: row.secret ?? null,
    prefix: row.prefix ?? null,
    agentImage: row.agentImage ?? null,
  };
}

/**
 * The agent harness image to use for a repo: its configured override, or null
 * when none is set (callers fall back to the server-wide HARNESS_IMAGE).
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
 * Whether the user (via their GitHub token) has admin on the repo — the
 * permission GitHub requires to create/modify webhooks. Returns false on any
 * API error so callers fail closed.
 */
export async function canManageWebhooks(
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
