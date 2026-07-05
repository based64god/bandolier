import { type V1Pod } from "@kubernetes/client-node";
import { inArray } from "drizzle-orm";

import { type TokenUsage } from "~/lib/tokens";
import { resolvePollToken } from "~/server/agents/github-app";
import { resolveItemStates } from "~/server/agents/github-issues";
import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import { inspectPod } from "~/server/agents/pod-inspection";
import { podFailure } from "~/server/agents/pod-failure";
import { JOB_TTL_SECONDS } from "~/server/agents/create-job";
import { type db } from "~/server/db";
import { taskRun } from "~/server/db/schema";

const INTERACTIVE_LABEL = "bandolier.io/interactive";

export interface OutputUrls {
  pullRequestUrl: string | null;
  createdIssueUrl: string | null;
  /** Persisted token usage (null when the run never reported any). */
  tokens: TokenUsage | null;
}

/** A pod's stable job name (falls back to the pod name for legacy pods). */
export function podJobName(pod: V1Pod): string {
  return (
    pod.metadata?.labels?.["bandolier.io/job"] ??
    pod.metadata?.name ??
    "unknown"
  );
}

/**
 * Batch-loads persisted output URLs for the terminal pods in `pods` in a single
 * query, keyed by job name. The harness records these via the ingest callback,
 * so a finished run's PR/issue links survive pod loss (TTL deletion, eviction,
 * node failure, transient log-read errors). Running pods are skipped — they have
 * no persisted output yet — so a list of only running pods issues no query at
 * all; otherwise the lookup is one `IN (...)` regardless of pod count, rather
 * than one query per pod.
 */
export async function loadPersistedOutputs(
  database: typeof db,
  pods: V1Pod[],
): Promise<Map<string, OutputUrls>> {
  const jobNames = pods
    .filter((p) => {
      const phase = p.status?.phase;
      return phase === "Succeeded" || phase === "Failed";
    })
    .map(podJobName);

  const byJob = new Map<string, OutputUrls>();
  if (jobNames.length === 0) return byJob;

  const rows = await database
    .select({
      jobName: taskRun.jobName,
      pullRequestUrl: taskRun.pullRequestUrl,
      createdIssueUrl: taskRun.createdIssueUrl,
      inputTokens: taskRun.inputTokens,
      outputTokens: taskRun.outputTokens,
      cacheReadInputTokens: taskRun.cacheReadInputTokens,
      cacheCreationInputTokens: taskRun.cacheCreationInputTokens,
    })
    .from(taskRun)
    .where(inArray(taskRun.jobName, jobNames));
  for (const row of rows) {
    byJob.set(row.jobName, {
      pullRequestUrl: row.pullRequestUrl,
      createdIssueUrl: row.createdIssueUrl,
      // Only treat the row as carrying usage when at least one field was
      // recorded — an un-reported run leaves all four null.
      tokens:
        row.inputTokens != null ||
        row.outputTokens != null ||
        row.cacheReadInputTokens != null ||
        row.cacheCreationInputTokens != null
          ? {
              inputTokens: row.inputTokens ?? 0,
              outputTokens: row.outputTokens ?? 0,
              cacheReadInputTokens: row.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: row.cacheCreationInputTokens ?? 0,
            }
          : null,
    });
  }
  return byJob;
}

/**
 * Merges a pod's log-derived output URLs with the batch-loaded persisted
 * fallback, preferring whatever the live logs supplied.
 */
export function mergeOutput(
  logUrls: OutputUrls,
  persisted: OutputUrls | undefined,
): OutputUrls {
  return {
    pullRequestUrl: logUrls.pullRequestUrl ?? persisted?.pullRequestUrl ?? null,
    createdIssueUrl:
      logUrls.createdIssueUrl ?? persisted?.createdIssueUrl ?? null,
    // Prefer the live log figure (it includes the latest interactive turn);
    // fall back to the persisted total once the pod's logs are gone.
    tokens: logUrls.tokens ?? persisted?.tokens ?? null,
  };
}

/**
 * Maps a pod into the task shape returned by `list`/`get`/`overview` (reads logs
 * once). `persistedOutputs` is the batch-loaded fallback keyed by job name (see
 * loadPersistedOutputs); it's consulted only when the logs don't supply a URL.
 * `viewerId` is the requesting user — repo views include collaborators' tasks,
 * and the UI needs to know which rows are the viewer's own (only those get
 * terminate/input controls; the server enforces the same on its mutations).
 */
export async function podToTask(
  pod: V1Pod,
  namespace: string,
  kubeconfig: string,
  database: typeof db,
  userGithubToken: string | null,
  nowMs: number,
  persistedOutputs: Map<string, OutputUrls>,
  viewerId: string,
) {
  const annotations = pod.metadata?.annotations ?? {};
  const name = pod.metadata?.name ?? "unknown";
  const status = pod.status?.phase ?? "Unknown";
  const ownedByViewer =
    pod.metadata?.labels?.[SPAWNED_BY_LABEL] === spawnedByLabelValue(viewerId);

  // The Job's TTL deletes it JOB_TTL_SECONDS after the harness container
  // finishes, so expiry = finishedAt + TTL. Null while running.
  const finishedAt =
    pod.status?.containerStatuses?.[0]?.state?.terminated?.finishedAt;
  const expiresAt = finishedAt
    ? new Date(
        new Date(finishedAt).getTime() + JOB_TTL_SECONDS * 1000,
      ).toISOString()
    : null;

  const inspection = await inspectPod(name, namespace, status, kubeconfig);
  const { currently, awaitingInput } = inspection;
  const jobName = podJobName(pod);
  // Fall back to the persisted output when logs didn't yield it (pod gone or a
  // transient log-read failure) — the harness records it on the run row.
  const { pullRequestUrl, createdIssueUrl, tokens } = mergeOutput(
    inspection,
    persistedOutputs.get(jobName),
  );

  const containerEnv = pod.spec?.containers?.[0]?.env ?? [];
  const prompt =
    containerEnv.find((e) => e.name === "CLAUDE_TASK")?.value ?? null;
  const interactive = pod.metadata?.labels?.[INTERACTIVE_LABEL] === "true";

  const creationTimestamp = pod.metadata?.creationTimestamp;

  const repoFullName = annotations["bandolier.io/repo"] ?? null;
  const issueUrl = annotations["bandolier.io/issue-url"] ?? null;
  const pollToken = await resolvePollToken(
    database,
    repoFullName,
    userGithubToken,
    nowMs,
  );
  const { pullRequestState, createdIssueState, issueState } =
    await resolveItemStates(pollToken, {
      pullRequestUrl,
      createdIssueUrl,
      issueUrl,
    });

  return {
    name,
    jobName,
    repoFullName,
    displayName: annotations["bandolier.io/display-name"] ?? name,
    // Pod creation time, used to sort the task list reverse-chronologically.
    createdAt: creationTimestamp
      ? new Date(creationTimestamp).toISOString()
      : null,
    prompt,
    source: pod.metadata?.labels?.["bandolier.io/source"] ?? "dashboard",
    issueNumber: annotations["bandolier.io/github-issue"] ?? null,
    issueUrl,
    createdBy: annotations["bandolier.io/created-by"] ?? null,
    // Lineage of a resumed run: the job it continues, for the UI to surface.
    parentJobName: annotations["bandolier.io/parent-job"] ?? null,
    parentDisplayName: annotations["bandolier.io/parent-name"] ?? null,
    // Whether this task belongs to the requesting user. Repo views also list
    // collaborators' tasks (read-only); the UI keys its controls off this.
    ownedByViewer,
    status,
    // Why a Failed pod failed (OOM kill, eviction, crash) — null otherwise.
    failure: podFailure(pod),
    currently,
    expiresAt,
    pullRequestUrl,
    pullRequestState,
    createdIssueUrl,
    createdIssueState,
    issueState,
    outputType:
      pod.metadata?.annotations?.["bandolier.io/output-type"] === "issue"
        ? ("issue" as const)
        : ("pr" as const),
    interactive,
    awaitingInput: interactive && awaitingInput,
    tokens,
  };
}
