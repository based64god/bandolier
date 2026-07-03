import { eq } from "drizzle-orm";

import { type ComputeSpec } from "~/lib/compute";
import { type db } from "~/server/db";
import { repoWebhookConfig, userCompute } from "~/server/db/schema";

/**
 * A stored compute default (user- or repo-level). Either field may be null —
 * set just a memory default and CPU falls through to the next source.
 */
export interface ComputeDefaults {
  cpu: string | null;
  memory: string | null;
}

/** Loads a user's stored compute default, or null if none is configured. */
export async function getUserCompute(
  database: typeof db,
  userId: string,
): Promise<ComputeDefaults | null> {
  const [row] = await database
    .select({ cpu: userCompute.cpu, memory: userCompute.memory })
    .from(userCompute)
    .where(eq(userCompute.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Loads a repo's compute default plus its prefer-credentials flag (which
 * orders it against the user's own default), or null when no config row
 * exists.
 */
export async function getRepoCompute(
  database: typeof db,
  repoFullName: string,
): Promise<(ComputeDefaults & { preferRepoCredentials: boolean }) | null> {
  const [row] = await database
    .select({
      cpu: repoWebhookConfig.computeCpu,
      memory: repoWebhookConfig.computeMemory,
      preferRepoCredentials: repoWebhookConfig.preferRepoCredentials,
    })
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, repoFullName))
    .limit(1);
  return row ?? null;
}

/**
 * Resolves the default compute for a run, mirroring resolveKubeconfig: the
 * repo's default and the user's own are ordered by the repo's
 * `preferRepoCredentials` flag (repo first when set, user first otherwise),
 * falling back to whichever is present. Resolution is per-field, so a repo
 * that only sets a memory default still inherits the user's CPU default.
 * `repoFullName` is optional — omit it for repo-less runs, which then only
 * consider the user's default. Fields nobody set stay null (callers fall
 * back to the built-in limits).
 */
export async function resolveCompute(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<ComputeDefaults> {
  const user = await getUserCompute(database, userId);
  const repo = repoFullName
    ? await getRepoCompute(database, repoFullName)
    : null;

  const pick = (r: string | null, u: string | null) =>
    repo?.preferRepoCredentials ? (r ?? u) : (u ?? r);
  return {
    cpu: pick(repo?.cpu ?? null, user?.cpu ?? null),
    memory: pick(repo?.memory ?? null, user?.memory ?? null),
  };
}

/**
 * Merges a per-task override onto the resolved defaults, yielding the
 * ComputeSpec to put on the job (undefined fields = the built-in limit).
 * Callers must validate override values before passing them here.
 */
export function mergeCompute(
  defaults: ComputeDefaults,
  override?: ComputeSpec,
): ComputeSpec | undefined {
  const cpu = override?.cpu ?? defaults.cpu ?? undefined;
  const memory = override?.memory ?? defaults.memory ?? undefined;
  if (cpu === undefined && memory === undefined) return undefined;
  return { cpu, memory };
}
