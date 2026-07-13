import { randomUUID } from "crypto";

import { and, desc, eq, isNull } from "drizzle-orm";

import { createAgentJob, type JobSpec } from "~/server/agents/create-job";
import { type db } from "~/server/db";
import { pendingAgentRun } from "~/server/db/schema";

/**
 * Approval flow for webhook-triggered agents that would run on a repo's *shared*
 * credentials (a repo-level kubeconfig or model API key). Such a run spends
 * pooled infrastructure / keys, so it's restricted to GitHub users with the
 * maintainer-or-higher privilege on the repo (see `repo-permissions`). When a
 * less-privileged user opens a qualifying issue, the run is held here instead of
 * dispatched: the bot leaves a comment asking a maintainer to approve, and a
 * maintainer's approving reply (`/bando approve`) replays the stored job spec.
 *
 * Rows are one-shot — a dispatched or declined run is stamped `resolvedAt` so it
 * can never fire twice — and hold the resolved credentials, so they're deleted
 * once resolved.
 */

/** A pending run's stored shape (the JobSpec is JSON in the `payload` column). */
export interface PendingRun {
  id: string;
  repoFullName: string;
  issueNumber: number;
  requestedByLogin: string;
  approvalCommentId: string | null;
  spec: JobSpec;
}

/**
 * Stores a held run and returns its id. The full createAgentJob spec is
 * serialized verbatim so approval replays the exact run that was gated.
 */
export async function storePendingRun(
  database: typeof db,
  args: {
    repoFullName: string;
    issueNumber: number;
    requestedByLogin: string;
    spec: JobSpec;
  },
): Promise<string> {
  const id = randomUUID();
  await database.insert(pendingAgentRun).values({
    id,
    repoFullName: args.repoFullName,
    issueNumber: args.issueNumber,
    requestedByLogin: args.requestedByLogin,
    payload: JSON.stringify(args.spec),
  });
  return id;
}

/** Records the id of the bot comment that asks a maintainer to approve. */
export async function setApprovalCommentId(
  database: typeof db,
  id: string,
  approvalCommentId: string,
): Promise<void> {
  await database
    .update(pendingAgentRun)
    .set({ approvalCommentId })
    .where(eq(pendingAgentRun.id, id));
}

/**
 * The most recent unresolved held run for an issue, or null. A reply approval
 * targets the issue (not a specific row), so the latest pending run is the one a
 * maintainer is responding to.
 */
export async function getUnresolvedPendingRun(
  database: typeof db,
  repoFullName: string,
  issueNumber: number,
): Promise<PendingRun | null> {
  const [row] = await database
    .select()
    .from(pendingAgentRun)
    .where(
      and(
        eq(pendingAgentRun.repoFullName, repoFullName),
        eq(pendingAgentRun.issueNumber, issueNumber),
        isNull(pendingAgentRun.resolvedAt),
      ),
    )
    .orderBy(desc(pendingAgentRun.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    issueNumber: row.issueNumber,
    requestedByLogin: row.requestedByLogin,
    approvalCommentId: row.approvalCommentId,
    spec: JSON.parse(row.payload) as JobSpec,
  };
}

/**
 * Marks a held run resolved (one-shot). Returns false if it was already
 * resolved — guarding against a double dispatch when two approvals race.
 */
export async function markResolved(
  database: typeof db,
  id: string,
  resolution: "dispatched" | "declined",
  resolvedByLogin: string,
): Promise<boolean> {
  const updated = await database
    .update(pendingAgentRun)
    .set({ resolvedAt: new Date(), resolution, resolvedByLogin })
    .where(and(eq(pendingAgentRun.id, id), isNull(pendingAgentRun.resolvedAt)))
    .returning({ id: pendingAgentRun.id });
  return updated.length > 0;
}

/**
 * Dispatches a held run: replays its stored spec via createAgentJob and returns
 * the new job name. Callers should `markResolved` first (atomically claiming the
 * row) so a dispatch can't fire twice.
 */
export async function dispatchPendingRun(run: PendingRun): Promise<string> {
  return createAgentJob(run.spec);
}
