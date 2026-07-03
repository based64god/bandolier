import { randomUUID } from "crypto";

import { setHeaderOptions, type V1Pod } from "@kubernetes/client-node";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { getArtifact, resolveArtifactStore } from "~/server/agents/artifacts";
import { validateAwsCredentials } from "~/server/agents/aws";
import {
  getGithubItemState,
  getIssue,
  postIssueCommentWithFallback,
  type GithubItemState,
} from "~/server/agents/github-issues";
import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import {
  buildIssueSystemPrompt,
  buildIssueUserMessage,
  makeIssueBranch,
} from "~/lib/issue-prompt";
import { EFFORT_LEVELS, providerSupportsEffort } from "~/lib/effort";
import { parseTokenUsageFromLogs, type TokenUsage } from "~/lib/tokens";
import {
  createAgentJob,
  DEFAULT_MAX_TURNS,
  JOB_TTL_SECONDS,
} from "~/server/agents/create-job";
import {
  getRegistryPullSecret,
  getRepoBotToken,
} from "~/server/agents/github-app";
import { userHasRepoAccess } from "~/server/agents/github-repos";
import {
  getGithubIdentity,
  getUserGithubToken,
  githubGitIdentity,
  type GitIdentity,
} from "~/server/agents/github-token";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
import { repoToNamespace } from "~/server/agents/namespace";
import {
  listModelsForUser,
  pickLatestGeminiFlash,
  pickLatestGptMini,
  pickLatestSonnet,
} from "~/server/agents/models";
import {
  pickProvider,
  resolveModelCredentials,
} from "~/server/agents/resolve-credentials";
import {
  getUserRepoPermission,
  isMaintainerOrHigher,
  runUsesRepoCredentials,
} from "~/server/agents/repo-permissions";
import {
  getRepoAgentImage,
  getRepoNetworkPolicy,
  getRepoSystemPrompt,
  type RepoNetworkPolicy,
} from "~/server/agents/webhook-config";
import { type db } from "~/server/db";
import { acpFrame, agentInput, taskRun } from "~/server/db/schema";
import { getBatchV1Api, getCoreV1Api } from "~/server/k8s/client";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const LABEL_SELECTOR = env.K8S_LABEL_SELECTOR;
const INTERACTIVE_LABEL = "bandolier.io/interactive";

const PR_MARKER = /PR_URL=(https:\/\/\S+)/;
// The harness logs this when an issue-output run opens its GitHub issue.
const ISSUE_MARKER = /ISSUE_URL=(https:\/\/\S+)/;
// Harness log markers bracketing an interactive turn: it prints AWAIT when it
// starts waiting for the next user message and RESUME when one arrives. The most
// recent of the two tells us whether the agent is currently awaiting input.
const AWAIT_MARKER = "BANDOLIER_AWAIT_INPUT";
const RESUME_MARKER = "BANDOLIER_RESUME";
// Tags transcript lines carrying a user's interactive message. Kept in sync with
// the harness (userInputMarker) and the dashboard's log renderer.
const USER_MARKER = "[user]";

/**
 * Sentinel input message that tells the harness to end an interactive session
 * (close Claude's stdin and run the post-run PR step). Kept in sync with the Go
 * harness's matching constant.
 */
export const END_SESSION_SENTINEL = "__BANDOLIER_END_SESSION__";

interface PodInspection {
  /** The most recent assistant (non-harness) line — what Claude is doing now. */
  currently: string | null;
  /** The pull-request URL the harness logged, if any. */
  pullRequestUrl: string | null;
  /** The URL of the issue an issue-output run created, if any. */
  createdIssueUrl: string | null;
  /** True when an interactive agent is currently waiting for user input. */
  awaitingInput: boolean;
  /**
   * The run's token usage, parsed from the harness's most recent token marker
   * in the logs. Null when no marker is present (run hasn't reported yet, or a
   * provider that doesn't report tokens).
   */
  tokens: TokenUsage | null;
}

// Pod inspections are cached. Terminal pods' logs are immutable, so those
// entries never expire. Running pods get a TTL just under the dashboard's 5s
// poll — every poll still re-reads the logs so "currently" stays live, but
// concurrent viewers of the same pods (repo collaborators, multiple tabs,
// overview + list) coalesce onto one log read per pod instead of one each.
// The in-flight promise is what's cached, so simultaneous calls share a
// single read rather than racing past an empty cache.
const RUNNING_INSPECTION_TTL_MS = 3_000;
const inspectionCache = new Map<
  string,
  { inspection: Promise<PodInspection>; freshUntil: number }
>();

/** The uncached log read behind inspectPod. Rejects on any read failure. */
async function readPodInspection(
  podName: string,
  namespace: string,
  terminal: boolean,
  kubeconfig: string,
): Promise<PodInspection> {
  const logs = await getCoreV1Api(kubeconfig).readNamespacedPodLog({
    name: podName,
    namespace,
    tailLines: 200,
  });

  const lines = logs.split("\n").map((l) => l.trim());

  // Forward pass: the last AWAIT/RESUME marker decides the awaiting state.
  let lastAwait = -1;
  let lastResume = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(AWAIT_MARKER)) lastAwait = i;
    if (lines[i]!.includes(RESUME_MARKER)) lastResume = i;
  }

  // Backward pass: the last assistant line is what Claude is doing now. Skip
  // both harness diagnostics and the user's own messages — neither is Claude.
  let currently: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line && !line.includes("[harness]") && !line.includes(USER_MARKER)) {
      currently = line;
      break;
    }
  }

  return {
    currently,
    pullRequestUrl: PR_MARKER.exec(logs)?.[1] ?? null,
    createdIssueUrl: ISSUE_MARKER.exec(logs)?.[1] ?? null,
    awaitingInput: !terminal && lastAwait >= 0 && lastAwait > lastResume,
    tokens: parseTokenUsageFromLogs(logs),
  };
}

/**
 * Reads a pod's recent logs once to derive both its live "currently" status (the
 * last assistant line) and any pull-request URL the harness produced.
 */
async function inspectPod(
  podName: string,
  namespace: string,
  phase: string,
  kubeconfig: string,
): Promise<PodInspection> {
  const terminal = phase === "Succeeded" || phase === "Failed";
  // Phase class is part of the key so a pod that just finished gets one fresh
  // terminal read instead of being served its cached running-phase inspection.
  const runningKey = `${namespace}/${podName}/running`;
  const key = terminal ? `${namespace}/${podName}/terminal` : runningKey;
  const cached = inspectionCache.get(key);
  if (cached && cached.freshUntil > Date.now()) return cached.inspection;

  const inspection: Promise<PodInspection> = readPodInspection(
    podName,
    namespace,
    terminal,
    kubeconfig,
  ).catch((): PodInspection => {
    // transient; evict so the next poll retries the read instead of being
    // served this empty fallback for the rest of the TTL. (A .catch callback
    // runs on a microtask, so `inspection` is always assigned by now.)
    if (inspectionCache.get(key)?.inspection === inspection) {
      inspectionCache.delete(key);
    }
    return {
      currently: null,
      pullRequestUrl: null,
      createdIssueUrl: null,
      awaitingInput: false,
      tokens: null,
    };
  });

  inspectionCache.set(key, {
    inspection,
    freshUntil: terminal ? Infinity : Date.now() + RUNNING_INSPECTION_TTL_MS,
  });
  // A terminal pod no longer needs its running-phase entry.
  if (terminal) inspectionCache.delete(runningKey);
  return inspection;
}

/**
 * Resolves the kubeconfig to use (server-wide, repo-scoped, or the user's own —
 * see resolveKubeconfig), throwing if none is set. Pass `repoFullName` so a
 * repo's shared cluster is considered for repo-scoped views.
 */
async function requireKubeconfig(
  db: Parameters<typeof resolveKubeconfig>[0],
  userId: string,
  repoFullName?: string,
): Promise<string> {
  const kubeconfig = await resolveKubeconfig(db, userId, repoFullName);
  if (!kubeconfig) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No kubeconfig configured. Add one in settings to manage agents.",
    });
  }
  return kubeconfig;
}

/**
 * Throws unless the acting user owns an agent with the given job name (matched by
 * the spawned-by label, so users can only send input to their own agents). The
 * pod must still exist, which it does for a live interactive session.
 */
async function assertOwnsInteractiveJob(
  db: Parameters<typeof resolveKubeconfig>[0],
  userId: string,
  namespace: string,
  jobName: string,
  repoFullName?: string,
): Promise<void> {
  const kubeconfig = await requireKubeconfig(db, userId, repoFullName);
  const res = await getCoreV1Api(kubeconfig).listNamespacedPod({
    namespace,
    labelSelector: `${LABEL_SELECTOR},${SPAWNED_BY_LABEL}=${spawnedByLabelValue(userId)},bandolier.io/job=${jobName}`,
  });
  if (res.items.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Interactive agent ${jobName} not found.`,
    });
  }
}

/**
 * Label selector that restricts a pod query to the agents the given user spawned.
 * Pods carry SPAWNED_BY_LABEL, so this enforces per-user ownership on a shared
 * cluster/namespace (the same control overview and assertOwnsInteractiveJob use).
 * Pass `extra` to AND in a further selector (e.g. a specific job).
 */
function ownedSelector(userId: string, extra?: string): string {
  const base = `${LABEL_SELECTOR},${SPAWNED_BY_LABEL}=${spawnedByLabelValue(userId)}`;
  return extra ? `${base},${extra}` : base;
}

/**
 * Label selector for a repo-scoped, read-only view. Tasks in a repo are visible
 * to every GitHub collaborator on that repo (the caller must already have
 * passed assertRepoAccess), not just their spawner — so when the query targets
 * the repo's own namespace, the spawned-by scoping is dropped. Any other
 * namespace/repo combination falls back to owner-scoping: the repo-access check
 * authorizes exactly one namespace (the repo's), and nothing else. Mutations
 * (terminate, rename, interactive input) never use this — they stay owner-only.
 */
function repoViewSelector(
  userId: string,
  namespace: string,
  repoFullName?: string,
  extra?: string,
): string {
  if (repoFullName && namespace === repoToNamespace(repoFullName)) {
    return extra ? `${LABEL_SELECTOR},${extra}` : LABEL_SELECTOR;
  }
  return ownedSelector(userId, extra);
}

// Short-TTL cache of confirmed (user → repo) access, so polled procedures (list,
// getLogs run every ~5s) don't hit the GitHub API on every call. Only positive
// results are cached: a member's checks are served from memory, while a
// non-member's repeated probes are never cached, so the map can't be grown by
// guessing repo names and revoked access is re-verified within the TTL.
const repoAccessCache = new Map<string, number>();
const REPO_ACCESS_TTL_MS = 60_000;

/**
 * Gates access to repo-scoped resources (a repo's shared kubeconfig/credentials
 * and its namespace). When a repoFullName is supplied, the caller must be able to
 * reach that repo through their own GitHub token — otherwise we refuse rather
 * than resolve another team's shared cluster/credentials for them. A no-op for
 * repo-less (personal) operations, which only ever use the caller's own creds.
 */
async function assertRepoAccess(
  db: Parameters<typeof resolveKubeconfig>[0],
  userId: string,
  repoFullName?: string,
): Promise<void> {
  if (!repoFullName) return;
  const key = `${userId} ${repoFullName}`;
  const cachedUntil = repoAccessCache.get(key);
  if (cachedUntil !== undefined && cachedUntil > Date.now()) return;

  const token = await getUserGithubToken(db, userId);
  if (!token || !(await userHasRepoAccess(token, repoFullName))) {
    repoAccessCache.delete(key);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You do not have access to ${repoFullName}.`,
    });
  }
  repoAccessCache.set(key, Date.now() + REPO_ACCESS_TTL_MS);
}

/**
 * The token to read PR/issue state with. Prefers the repo's GitHub App
 * installation token (a bot-voice read that doesn't depend on the viewer having
 * a GitHub account or spend their rate limit), falling back to the viewer's own
 * token when the App isn't installed on the repo. Returns null when neither is
 * available, so polling degrades to no state badge rather than failing.
 */
async function resolvePollToken(
  database: typeof db,
  repoFullName: string | null,
  userGithubToken: string | null,
  nowMs: number,
): Promise<string | null> {
  if (repoFullName) {
    const botToken = await getRepoBotToken(database, repoFullName, nowMs);
    if (botToken) return botToken;
  }
  return userGithubToken;
}

/**
 * Resolves the open/closed/merged state of a created PR, created issue, and
 * source issue for a task. Best-effort: without a GitHub token (or on an API
 * failure) the states stay null and the badges render without an indicator.
 */
async function resolveItemStates(
  githubToken: string | null,
  urls: {
    pullRequestUrl: string | null;
    createdIssueUrl: string | null;
    issueUrl: string | null;
  },
): Promise<{
  pullRequestState: GithubItemState | null;
  createdIssueState: GithubItemState | null;
  issueState: GithubItemState | null;
}> {
  if (!githubToken) {
    return {
      pullRequestState: null,
      createdIssueState: null,
      issueState: null,
    };
  }
  const [pullRequestState, createdIssueState, issueState] = await Promise.all([
    urls.pullRequestUrl
      ? getGithubItemState(githubToken, urls.pullRequestUrl)
      : null,
    urls.createdIssueUrl
      ? getGithubItemState(githubToken, urls.createdIssueUrl)
      : null,
    urls.issueUrl ? getGithubItemState(githubToken, urls.issueUrl) : null,
  ]);
  return { pullRequestState, createdIssueState, issueState };
}

interface OutputUrls {
  pullRequestUrl: string | null;
  createdIssueUrl: string | null;
  /** Persisted token usage (null when the run never reported any). */
  tokens: TokenUsage | null;
}

/** A pod's stable job name (falls back to the pod name for legacy pods). */
function podJobName(pod: V1Pod): string {
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
async function loadPersistedOutputs(
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
function mergeOutput(
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
 * Maps a pod into the task shape returned by `list`/`get` (reads logs once).
 * `persistedOutputs` is the batch-loaded fallback keyed by job name (see
 * loadPersistedOutputs); it's consulted only when the logs don't supply a URL.
 * `viewerId` is the requesting user — repo views include collaborators' tasks,
 * and the UI needs to know which rows are the viewer's own (only those get
 * terminate/input controls; the server enforces the same on its mutations).
 */
async function podToTask(
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

export const agentsRouter = createTRPCRouter({
  // Reports the configured model provider for a deploy (AWS Bedrock takes
  // precedence over an Anthropic key). When a repo is given, repo-scoped
  // credentials are considered alongside the user's own per the repo's
  // prefer-credentials flag; `source` says which set won.
  providerInfo: protectedProcedure
    .input(z.object({ repoFullName: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const creds = await resolveModelCredentials(
        ctx.db,
        ctx.session.user.id,
        input?.repoFullName,
      );
      const {
        aws,
        anthropicApiKey,
        anthropicOauthToken,
        openaiApiKey,
        codexAuthJson,
        geminiApiKey,
      } = pickProvider(creds);
      if (aws) {
        return {
          provider: "bedrock" as const,
          region: aws.region,
          source: creds.source,
        };
      }
      if (anthropicApiKey ?? anthropicOauthToken) {
        return {
          provider: "anthropic" as const,
          region: null,
          source: creds.source,
        };
      }
      if (openaiApiKey ?? codexAuthJson) {
        return {
          provider: "openai" as const,
          region: null,
          source: creds.source,
        };
      }
      if (geminiApiKey) {
        return {
          provider: "gemini" as const,
          region: null,
          source: creds.source,
        };
      }
      return {
        provider: "none" as const,
        region: null,
        source: "none" as const,
      };
    }),

  // Deploy-form defaults sourced from the server so the UI stays in sync.
  deployDefaults: protectedProcedure.query(() => ({
    maxTurns: DEFAULT_MAX_TURNS,
  })),

  // Cross-repo overview for the home screen: every agent the acting user spawned,
  // regardless of repository (including repo-less tasks, and webhook tasks
  // triggered by the user's GitHub account). Permission is enforced by the label
  // selector — pods are tagged with their owner's id, so we ask Kubernetes only
  // for this user's pods rather than scanning every pod. Lightweight by design
  // (no per-pod log reads): the per-repo view carries "currently"/PR detail.
  overview: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const kubeconfig = await requireKubeconfig(ctx.db, userId);
    const githubToken = await getUserGithubToken(ctx.db, userId);
    const nowMs = Date.now();

    try {
      const res = await getCoreV1Api(kubeconfig).listPodForAllNamespaces({
        labelSelector: `${LABEL_SELECTOR},${SPAWNED_BY_LABEL}=${spawnedByLabelValue(userId)}`,
      });

      // One batched query recovers persisted output for every terminal pod whose
      // logs are gone — rather than a lookup per pod.
      const persistedOutputs = await loadPersistedOutputs(ctx.db, res.items);

      return await Promise.all(
        res.items.map(async (pod) => {
          const annotations = pod.metadata?.annotations ?? {};
          const name = pod.metadata?.name ?? "unknown";
          const namespace = pod.metadata?.namespace ?? "";
          const status = pod.status?.phase ?? "Unknown";

          // The pull-request URL lives in the harness logs; read it per pod
          // (cheap here — only the user's own agents, and terminal pods cache).
          const inspection = await inspectPod(
            name,
            namespace,
            status,
            kubeconfig,
          );
          const { awaitingInput } = inspection;
          const jobName = podJobName(pod);
          // Fall back to the persisted output when the logs are gone (TTL
          // deletion, eviction) or unreadable — kept on the durable run row.
          const { pullRequestUrl, createdIssueUrl, tokens } = mergeOutput(
            inspection,
            persistedOutputs.get(jobName),
          );
          const interactive =
            pod.metadata?.labels?.[INTERACTIVE_LABEL] === "true";

          const repoFullName = annotations["bandolier.io/repo"] ?? null;
          const issueUrl = annotations["bandolier.io/issue-url"] ?? null;
          const pollToken = await resolvePollToken(
            ctx.db,
            repoFullName,
            githubToken,
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
            namespace,
            repoFullName,
            displayName: annotations["bandolier.io/display-name"] ?? name,
            // Pod creation time, used to sort the overview reverse-chronologically.
            createdAt: pod.metadata?.creationTimestamp
              ? new Date(pod.metadata.creationTimestamp).toISOString()
              : null,
            source:
              pod.metadata?.labels?.["bandolier.io/source"] ?? "dashboard",
            issueNumber: annotations["bandolier.io/github-issue"] ?? null,
            issueUrl,
            createdBy: annotations["bandolier.io/created-by"] ?? null,
            // Lineage of a resumed run, surfaced next to the task name.
            parentJobName: annotations["bandolier.io/parent-job"] ?? null,
            parentDisplayName: annotations["bandolier.io/parent-name"] ?? null,
            status,
            pullRequestUrl,
            pullRequestState,
            createdIssueUrl,
            createdIssueState,
            issueState,
            outputType:
              annotations["bandolier.io/output-type"] === "issue"
                ? ("issue" as const)
                : ("pr" as const),
            interactive,
            awaitingInput: interactive && awaitingInput,
            tokens,
          };
        }),
      );
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Failed to list agents",
        cause: err,
      });
    }
  }),

  list: protectedProcedure
    .input(
      z.object({
        namespace: z.string().min(1),
        // The repo this view is scoped to, so a repo's shared cluster is used.
        repoFullName: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;
      await assertRepoAccess(ctx.db, userId, input.repoFullName);
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        userId,
        input.repoFullName,
      );
      const githubToken = await getUserGithubToken(ctx.db, userId);
      const nowMs = Date.now();
      try {
        // Repo views list every collaborator's tasks in the repo's namespace
        // (read-only for non-owners); repo-less queries stay owner-scoped.
        const res = await getCoreV1Api(kubeconfig).listNamespacedPod({
          namespace: input.namespace,
          labelSelector: repoViewSelector(
            userId,
            input.namespace,
            input.repoFullName,
          ),
        });
        // One batched query recovers persisted output for every terminal pod
        // whose logs are gone — rather than a lookup per pod.
        const persistedOutputs = await loadPersistedOutputs(ctx.db, res.items);
        return await Promise.all(
          res.items.map((pod) =>
            podToTask(
              pod,
              input.namespace,
              kubeconfig,
              ctx.db,
              githubToken,
              nowMs,
              persistedOutputs,
              userId,
            ),
          ),
        );
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to list pods",
          cause: err,
        });
      }
    }),

  // Fetch a single task by its job name (stable across the pod's lifetime).
  get: protectedProcedure
    .input(
      z.object({
        namespace: z.string().min(1),
        jobName: z.string().min(1),
        repoFullName: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;
      await assertRepoAccess(ctx.db, userId, input.repoFullName);
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        userId,
        input.repoFullName,
      );
      try {
        // Like `list`, visible to any collaborator when repo-scoped.
        const res = await getCoreV1Api(kubeconfig).listNamespacedPod({
          namespace: input.namespace,
          labelSelector: repoViewSelector(
            userId,
            input.namespace,
            input.repoFullName,
            `bandolier.io/job=${input.jobName}`,
          ),
        });
        const pod = res.items[0];
        if (!pod) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Task ${input.jobName} not found`,
          });
        }
        const githubToken = await getUserGithubToken(ctx.db, userId);
        const persistedOutputs = await loadPersistedOutputs(ctx.db, [pod]);
        return await podToTask(
          pod,
          input.namespace,
          kubeconfig,
          ctx.db,
          githubToken,
          Date.now(),
          persistedOutputs,
          userId,
        );
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to get task",
          cause: err,
        });
      }
    }),

  // Rename a task: patches the display-name annotation on the Job and its pods so
  // the change shows in both the per-repo list and the cross-repo overview.
  rename: protectedProcedure
    .input(
      z.object({
        namespace: z.string().min(1),
        jobName: z.string().min(1),
        displayName: z.string().min(1).max(300),
        repoFullName: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;
      await assertRepoAccess(ctx.db, userId, input.repoFullName);
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        userId,
        input.repoFullName,
      );
      const core = getCoreV1Api(kubeconfig);
      const merge = setHeaderOptions(
        "Content-Type",
        "application/merge-patch+json",
      );
      const body = {
        metadata: {
          annotations: { "bandolier.io/display-name": input.displayName },
        },
      };
      try {
        // Confirm the caller owns this job before mutating it; this also yields
        // the exact pods (theirs) to patch.
        const pods = await core.listNamespacedPod({
          namespace: input.namespace,
          labelSelector: ownedSelector(
            userId,
            `bandolier.io/job=${input.jobName}`,
          ),
        });
        if (pods.items.length === 0) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Task ${input.jobName} not found`,
          });
        }
        await getBatchV1Api(kubeconfig).patchNamespacedJob(
          { name: input.jobName, namespace: input.namespace, body },
          merge,
        );
        await Promise.all(
          pods.items.map((p) =>
            core.patchNamespacedPod(
              { name: p.metadata!.name!, namespace: input.namespace, body },
              merge,
            ),
          ),
        );
        return { success: true };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to rename task",
          cause: err,
        });
      }
    }),

  getLogs: protectedProcedure
    .input(
      z.object({
        podName: z.string().min(1),
        namespace: z.string().min(1),
        // Used to fall back to the persisted transcript once the pod is gone.
        jobName: z.string().optional(),
        container: z.string().optional(),
        repoFullName: z.string().optional(),
        // The modal grows this as the user scrolls up to load older lines.
        tailLines: z.number().int().min(10).max(10000).default(200),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;
      await assertRepoAccess(ctx.db, userId, input.repoFullName);
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        userId,
        input.repoFullName,
      );
      try {
        // Only read logs for a pod the caller may view: their own, or — for a
        // query bound to the repo's own namespace — any collaborator's task in
        // that repo. A pod outside that set simply won't appear here, so we
        // never read across tenants.
        const visible = await getCoreV1Api(kubeconfig).listNamespacedPod({
          namespace: input.namespace,
          labelSelector: repoViewSelector(
            userId,
            input.namespace,
            input.repoFullName,
          ),
        });
        const mayView = visible.items.some(
          (p) => p.metadata?.name === input.podName,
        );
        if (mayView) {
          return await getCoreV1Api(kubeconfig).readNamespacedPodLog({
            name: input.podName,
            namespace: input.namespace,
            container: input.container,
            tailLines: input.tailLines,
          });
        }
        // Pod isn't among the caller's pods — it may be gone after its TTL. Fall
        // through to the persisted transcript, which is itself owner-scoped.
      } catch {
        // Listing/log read failed transiently — try the transcript fallback.
      }
      // Persisted-transcript fallback. Readable by the run's owner, or by any
      // collaborator when the run belongs to the repo this query was authorized
      // for (assertRepoAccess above) — the run row's own repo is what's
      // checked, so naming an accessible repo can't unlock another repo's run
      // off a guessable jobName.
      const jobName = input.jobName;
      if (jobName) {
        const [run] = await ctx.db
          .select({
            transcriptKey: taskRun.transcriptKey,
            repoFullName: taskRun.repoFullName,
            spawnedBy: taskRun.spawnedBy,
          })
          .from(taskRun)
          .where(eq(taskRun.jobName, jobName))
          .limit(1);
        const mayViewRun =
          run &&
          (run.spawnedBy === userId ||
            (!!run.repoFullName && run.repoFullName === input.repoFullName));
        if (mayViewRun && run.transcriptKey) {
          // Resolve the same store the ingest path wrote to: the run's repo
          // bucket (the only store — no server-wide fallback exists).
          const store = await resolveArtifactStore(ctx.db, run.repoFullName);
          if (store) {
            const transcript = await getArtifact(store, run.transcriptKey);
            if (transcript !== null) return transcript;
          }
        }
      }
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Logs not found",
      });
    }),

  terminate: protectedProcedure
    .input(
      z.object({
        podName: z.string().min(1),
        namespace: z.string().min(1),
        repoFullName: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;
      await assertRepoAccess(ctx.db, userId, input.repoFullName);
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        userId,
        input.repoFullName,
      );
      try {
        // Only terminate a pod the caller owns — never delete another user's pod
        // by raw name on a shared namespace.
        const owned = await getCoreV1Api(kubeconfig).listNamespacedPod({
          namespace: input.namespace,
          labelSelector: ownedSelector(userId),
        });
        const owns = owned.items.some(
          (p) => p.metadata?.name === input.podName,
        );
        if (!owns) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Pod ${input.podName} not found`,
          });
        }
        await getCoreV1Api(kubeconfig).deleteNamespacedPod({
          name: input.podName,
          namespace: input.namespace,
        });
        return { success: true };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            err instanceof Error ? err.message : "Failed to terminate pod",
          cause: err,
        });
      }
    }),

  // Queue a user message for an interactive agent. The harness polls the input
  // endpoint and feeds it to Claude as the next turn. Ownership is enforced by
  // the spawned-by label so a user can only drive their own agents.
  sendInput: protectedProcedure
    .input(
      z.object({
        namespace: z.string().min(1),
        jobName: z.string().min(1),
        content: z.string().min(1).max(20000),
        repoFullName: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnsInteractiveJob(
        ctx.db,
        ctx.session.user.id,
        input.namespace,
        input.jobName,
        input.repoFullName,
      );
      await ctx.db.insert(agentInput).values({
        id: randomUUID(),
        jobName: input.jobName,
        content: input.content,
      });
      return { success: true };
    }),

  // Gracefully end an interactive session: the sentinel tells the harness to
  // close Claude's stdin and run its post-run PR step, rather than killing the
  // pod outright (which `terminate` does).
  endSession: protectedProcedure
    .input(
      z.object({
        namespace: z.string().min(1),
        jobName: z.string().min(1),
        repoFullName: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnsInteractiveJob(
        ctx.db,
        ctx.session.user.id,
        input.namespace,
        input.jobName,
        input.repoFullName,
      );
      await ctx.db.insert(agentInput).values({
        id: randomUUID(),
        jobName: input.jobName,
        content: END_SESSION_SENTINEL,
      });
      return { success: true };
    }),

  // ── ACP relay (interactive sessions) ──────────────────────────────────────
  // The frontend is the ACP client; these procedures are its HTTP transport. The
  // harness proxies between the acp_frame queue and the in-pod agent. Ownership
  // is enforced by the spawned-by label, like sendInput/endSession.

  // Enqueue one client→agent frame (a raw JSON-RPC string from the frontend
  // client: initialize/session.new/prompt/cancel or a Bandolier control frame).
  acpSend: protectedProcedure
    .input(
      z.object({
        namespace: z.string().min(1),
        jobName: z.string().min(1),
        frame: z.string().min(1).max(200000),
        repoFullName: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertOwnsInteractiveJob(
        ctx.db,
        ctx.session.user.id,
        input.namespace,
        input.jobName,
        input.repoFullName,
      );
      await ctx.db.insert(acpFrame).values({
        jobName: input.jobName,
        direction: "c2a",
        payload: input.frame,
      });
      return { success: true };
    }),

  // Poll for the session's frames after a cursor (the last seq seen). Returns
  // the frames oldest-first plus the new cursor; the frontend client feeds them
  // into its ACP connection and advances the cursor. Both directions are
  // returned: the user's own turns exist in the relay only as client→agent
  // session/prompt frames, so a replay (page reload, or reopening a finished
  // session) needs them to show both sides of the conversation. The client
  // ignores frames it doesn't render (cancels, control frames).
  acpPull: protectedProcedure
    .input(
      z.object({
        namespace: z.string().min(1),
        jobName: z.string().min(1),
        cursor: z.number().int().nonnegative().default(0),
        repoFullName: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;
      await assertRepoAccess(ctx.db, userId, input.repoFullName);
      // Authorize against the durable run row, not the live pod, so a finished
      // session's conversation stays readable after its pod is gone (and each
      // poll skips a k8s round-trip). Visibility matches the persisted
      // transcript in getLogs: the run's owner, or any collaborator when the
      // run belongs to the repo this query was authorized for. Rows predating
      // spawnedBy (or pruned rows) fall back to the live-pod ownership check.
      const [run] = await ctx.db
        .select({
          spawnedBy: taskRun.spawnedBy,
          repoFullName: taskRun.repoFullName,
        })
        .from(taskRun)
        .where(eq(taskRun.jobName, input.jobName))
        .limit(1);
      const mayViewRun =
        run &&
        (run.spawnedBy === userId ||
          (!!run.repoFullName && run.repoFullName === input.repoFullName));
      if (!mayViewRun) {
        await assertOwnsInteractiveJob(
          ctx.db,
          userId,
          input.namespace,
          input.jobName,
          input.repoFullName,
        );
      }
      const rows = await ctx.db
        .select({ seq: acpFrame.seq, payload: acpFrame.payload })
        .from(acpFrame)
        .where(
          and(
            eq(acpFrame.jobName, input.jobName),
            gt(acpFrame.seq, input.cursor),
          ),
        )
        .orderBy(asc(acpFrame.seq))
        .limit(500);
      const cursor =
        rows.length > 0 ? rows[rows.length - 1]!.seq : input.cursor;
      return { frames: rows, cursor };
    }),

  deploy: protectedProcedure
    .input(
      z
        .object({
          namespace: z.string().min(1),
          // Operator task / additional context. Optional when an issue is picked.
          task: z.string().default(""),
          repoUrl: z.string().url().optional().or(z.literal("")),
          repoFullName: z.string().optional(),
          branch: z.string().default("main"),
          // A model id from one of the user's providers (see models.list).
          model: z.string().min(1),
          // The provider the chosen model is served by, so deploy uses the right
          // credentials when several are configured. Optional: programmatic
          // clients may omit it, falling back to the primary-provider precedence.
          modelProvider: z
            .enum(["anthropic", "bedrock", "openai", "gemini"])
            .optional(),
          // Which credential kind to run on, for providers where both a metered
          // API key and a subscription login can be configured (Anthropic,
          // OpenAI). The picker offers the same model once per kind; this pins
          // the run to the picked one. Optional: unset falls back to the
          // API-key-beats-subscription precedence.
          modelAuth: z.enum(["api_key", "subscription"]).optional(),
          // Reasoning effort for the run (Claude providers only; ignored for
          // OpenAI/Gemini). Optional — unset uses the CLI default.
          effort: z.enum(EFFORT_LEVELS).optional(),
          maxTurns: z.number().int().min(1).max(200).optional(),
          // When set, the agent works on this GitHub issue (and the task field
          // becomes additional context).
          issueNumber: z.number().int().positive().optional(),
          // Run as a long-lived interactive session that waits for user input
          // between turns instead of a one-shot task.
          interactive: z.boolean().optional(),
          // What the run produces: a pull request (default) or a GitHub issue.
          // "issue" runs the agent read-only and opens one issue from its
          // findings (a sub-task of the selected issue, when one is picked).
          outputType: z.enum(["pr", "issue"]).optional(),
        })
        .refine(
          (v) => v.task.trim().length > 0 || v.issueNumber !== undefined,
          {
            message: "Provide a task or select an issue.",
            path: ["task"],
          },
        ),
    )
    .mutation(async ({ input, ctx }) => {
      // Treat an empty repo URL as "no repository".
      const repoUrl = input.repoUrl?.length ? input.repoUrl : undefined;

      // Issue output needs a repository to open the issue in.
      const issueOutput = input.outputType === "issue";
      if (issueOutput && !input.repoFullName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A repository is required to create an issue.",
        });
      }

      console.log("[bandolier:deploy] starting", {
        namespace: input.namespace,
        model: input.model,
        repo: repoUrl ?? null,
        task:
          input.task.length > 80 ? `${input.task.slice(0, 80)}…` : input.task,
        user: ctx.session?.user?.email ?? "unknown",
      });

      const userId = ctx.session.user.id;

      // A repo's shared cluster and credentials are only for users who can reach
      // that repo. Verify access before resolving anything repo-scoped, so a
      // non-member can't deploy under another team's kubeconfig/cloud creds.
      await assertRepoAccess(ctx.db, userId, input.repoFullName);

      // Resolve the cluster: server-wide, then repo-scoped vs. the user's own
      // per the repo's prefer-credentials flag.
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        userId,
        input.repoFullName,
      );

      // Resolve model credentials, then pick the set that matches the provider of
      // the model the user chose (so a user with several providers configured
      // gets the right one). When the provider is omitted — e.g. a REST/webhook
      // client with no picker — fall back to the primary-provider precedence.
      const resolved = await resolveModelCredentials(
        ctx.db,
        userId,
        input.repoFullName,
      );
      const primary = pickProvider(resolved);
      const provider =
        input.modelProvider ??
        (resolved.aws
          ? "bedrock"
          : resolved.anthropicApiKey || resolved.anthropicOauthToken
            ? "anthropic"
            : resolved.openaiApiKey || resolved.codexAuthJson
              ? "openai"
              : resolved.geminiApiKey
                ? "gemini"
                : undefined);

      // The picker offers a model once per credential kind, so an explicit
      // modelAuth pins the run to that kind ("run this on my subscription" vs
      // "on my API key"). Unset — programmatic clients — falls back to the
      // API-key-beats-subscription precedence.
      const wantSubscription = input.modelAuth === "subscription";
      const wantApiKey = input.modelAuth === "api_key";
      const awsCredentials =
        provider === "bedrock" ? (resolved.aws ?? primary.aws) : null;
      const anthropicApiKey =
        provider === "anthropic" && !wantSubscription
          ? (resolved.anthropicApiKey ?? primary.anthropicApiKey)
          : null;
      const anthropicOauthToken =
        provider === "anthropic" && !wantApiKey && !anthropicApiKey
          ? (resolved.anthropicOauthToken ?? primary.anthropicOauthToken)
          : null;
      const openaiApiKey =
        provider === "openai" && !wantSubscription
          ? (resolved.openaiApiKey ?? primary.openaiApiKey)
          : null;
      const codexAuthJson =
        provider === "openai" && !wantApiKey && !openaiApiKey
          ? (resolved.codexAuthJson ?? primary.codexAuthJson)
          : null;
      const geminiApiKey =
        provider === "gemini"
          ? (resolved.geminiApiKey ?? primary.geminiApiKey)
          : null;

      if (
        !awsCredentials &&
        !anthropicApiKey &&
        !anthropicOauthToken &&
        !openaiApiKey &&
        !codexAuthJson &&
        !geminiApiKey
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "No model credentials configured for the selected model. Add AWS Bedrock, an Anthropic, OpenAI, or Gemini API key in settings (or repo configuration) before deploying.",
        });
      }

      // Validate AWS credentials up-front (catches expired STS sessions) so a
      // clear error surfaces instead of a pod that fails to authenticate.
      if (awsCredentials) {
        const validation = await validateAwsCredentials(awsCredentials);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `AWS credentials check failed: ${validation.error ?? "invalid"}. Update them in account settings.`,
          });
        }
        console.log("[bandolier:deploy] aws credentials valid", {
          arn: validation.arn,
        });
      }

      try {
        // Use the deploying user's GitHub OAuth token so the harness clones,
        // commits, and opens the PR as them — with commits attributed to them.
        const githubToken = await getUserGithubToken(ctx.db, userId);
        if (!githubToken) {
          console.warn("[bandolier:deploy] user has no linked GitHub token");
        }

        // Attribute commits to the deploying user. Prefer their GitHub no-reply
        // address (guarantees GitHub links the commits to that account); fall
        // back to the account email if there's no token or the lookup fails.
        let gitIdentity: GitIdentity = {
          name: ctx.session.user.name,
          email: ctx.session.user.email,
        };
        let githubLogin: string | null = null;
        if (githubToken) {
          try {
            const gh = await getGithubIdentity(githubToken);
            gitIdentity = githubGitIdentity(gh.id, gh.login);
            githubLogin = gh.login;
          } catch (err) {
            console.warn("[bandolier:deploy] GitHub identity lookup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Privilege gate: a run that would spend the repo's *shared* credentials
        // (a repo-level kubeconfig or model key) is restricted to GitHub users
        // with maintainer-or-higher on the repo. A less-privileged user can only
        // use their own credentials. (The webhook path holds such a run for a
        // maintainer's approval; from the dashboard/REST we reject it outright,
        // since the actor is present to be told why.)
        if (input.repoFullName) {
          const usesRepoCreds = await runUsesRepoCredentials(
            ctx.db,
            userId,
            input.repoFullName,
            resolved,
          );
          if (usesRepoCreds) {
            if (!githubToken || !githubLogin) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message:
                  "A linked GitHub account is required to run on this repository's shared credentials.",
              });
            }
            const permission = await getUserRepoPermission(
              githubToken,
              input.repoFullName,
              githubLogin,
            );
            if (!isMaintainerOrHigher(permission)) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message:
                  "This run would use the repository's shared credentials, which requires maintainer access or higher. Ask a maintainer to run it, or configure your own credentials in settings.",
              });
            }
          }
        }

        // When an issue is selected, fetch its details for the display label and
        // wire issue mode so the harness builds context + opens a closing PR.
        let issue: {
          number: number;
          title: string;
          url: string;
          body: string;
        } | null = null;
        if (input.issueNumber !== undefined) {
          if (!input.repoFullName) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "A repository is required to work on an issue.",
            });
          }
          if (!githubToken) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "A linked GitHub account is required to work on an issue.",
            });
          }
          issue = await getIssue(
            githubToken,
            input.repoFullName,
            input.issueNumber,
          );
          if (!issue) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `Issue #${input.issueNumber} not found in ${input.repoFullName}.`,
            });
          }
        }

        const taskPreview =
          input.task.length > 60 ? `${input.task.slice(0, 60)}…` : input.task;
        const displayName = issue
          ? `#${issue.number}: ${issue.title}`
          : taskPreview;

        // For an issue PR: generate a unique working branch and build the
        // instructional (commit-and-open-PR) framing here. For issue output we
        // skip both — the harness frames the read-only analysis and opens the
        // issue itself. Either way the issue context (with the operator's task as
        // additional context) is the user message stored as CLAUDE_TASK.
        let agentBranch: string | undefined;
        let systemPrompt: string | undefined;
        if (issue && !issueOutput) {
          agentBranch = makeIssueBranch(issue.number, issue.title);
          systemPrompt = buildIssueSystemPrompt(issue, agentBranch);
        }
        const task = issue
          ? buildIssueUserMessage(issue, input.task)
          : input.task;

        // PR-producing runs (repo or issue mode) get their PR title/description
        // written out-of-band of the (possibly larger) task model by a cheap
        // writer from the same provider: the latest Sonnet for Claude runs, the
        // latest GPT mini for OpenAI runs. Best-effort: a lookup failure falls
        // back to the harness's commit-based title and must not block the deploy.
        let prWriterModel: string | undefined;
        if (repoUrl ?? issue ?? issueOutput) {
          try {
            const { models } = await listModelsForUser(
              ctx.db,
              userId,
              input.repoFullName,
            );
            prWriterModel =
              provider === "openai"
                ? pickLatestGptMini(models)
                : provider === "gemini"
                  ? pickLatestGeminiFlash(models)
                  : pickLatestSonnet(models);
          } catch (err) {
            console.warn("[bandolier:deploy] PR-writer model lookup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Per-repo harness image override (falls back to DEFAULT_HARNESS_IMAGE
        // when unset) and the repo-attached system prompt appended to every run.
        // Best-effort: a lookup failure must not block the deploy.
        let agentImage: string | undefined;
        let imagePullSecret:
          | { registry: string; dockerConfigJson: string }
          | undefined;
        let repoSystemPrompt: string | undefined;
        // Per-repo network-policy config (egress toggles / custom policy YAML,
        // all unset by default, keeping the locked-down baseline). Best-effort
        // like the other repo lookups.
        let networkPolicy: RepoNetworkPolicy | undefined;
        if (input.repoFullName) {
          try {
            agentImage =
              (await getRepoAgentImage(ctx.db, input.repoFullName)) ??
              undefined;
          } catch (err) {
            console.warn("[bandolier:deploy] agent image lookup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // A custom image on a private ghcr.io package needs pull credentials —
          // use the deploying user's GitHub OAuth token (GHCR rejects App
          // installation tokens). Best-effort: no token leaves the cluster to
          // pull with its own node credentials.
          if (agentImage) {
            imagePullSecret =
              getRegistryPullSecret(agentImage, githubToken) ?? undefined;
          }
          try {
            repoSystemPrompt =
              (await getRepoSystemPrompt(ctx.db, input.repoFullName)) ??
              undefined;
          } catch (err) {
            console.warn(
              "[bandolier:deploy] repo system prompt lookup failed",
              {
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
          try {
            networkPolicy =
              (await getRepoNetworkPolicy(ctx.db, input.repoFullName)) ??
              undefined;
          } catch (err) {
            console.warn("[bandolier:deploy] network policy lookup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const jobName = await createAgentJob({
          namespace: input.namespace,
          task,
          systemPrompt,
          agentBranch,
          displayName,
          repoUrl,
          repoFullName: input.repoFullName,
          branch: input.branch,
          model: input.model,
          // Effort is Claude-only; drop it for OpenAI/Gemini runs even if a
          // client sent one, so it's never forwarded to a CLI that rejects it.
          effort:
            provider && providerSupportsEffort(provider)
              ? input.effort
              : undefined,
          maxTurns: input.maxTurns,
          prWriterModel,
          interactive: input.interactive,
          outputType: input.outputType,
          issueNumber: issue ? String(issue.number) : undefined,
          issueUrl: issue?.url,
          userId,
          githubToken: githubToken ?? undefined,
          awsCredentials: awsCredentials ?? undefined,
          anthropicApiKey: anthropicApiKey ?? undefined,
          anthropicOauthToken: anthropicOauthToken ?? undefined,
          openaiApiKey: openaiApiKey ?? undefined,
          codexAuthJson: codexAuthJson ?? undefined,
          geminiApiKey: geminiApiKey ?? undefined,
          kubeconfig,
          agentImage: agentImage ?? undefined,
          imagePullSecret,
          repoSystemPrompt,
          networkPolicy,
          createdBy: ctx.session.user.name ?? ctx.session.user.email,
          gitName: gitIdentity.name,
          gitEmail: gitIdentity.email,
        });

        // When a task is spawned from a GitHub issue (via the dashboard or the
        // REST API), leave a comment so the issue author knows it was received.
        // This is a bot-voice comment ("🤖 Bando picked up this issue…"), so it
        // must only ever be posted by the bot itself — exclusively the GitHub
        // App installation token, attributed to bandolier[bot]. We deliberately
        // do NOT fall back to the legacy service-user PAT or the deploying
        // user's OAuth token: a comment that speaks in the bot's voice but is
        // attributed to a human (or a generic service user) is misleading. With
        // no App installation there's no bot identity to comment as, so we skip
        // the comment rather than post it under another credential.
        if (issue && input.repoFullName) {
          const botToken = await getRepoBotToken(
            ctx.db,
            input.repoFullName,
            Date.now(),
          );
          const taskUrl = `${env.BETTER_AUTH_URL}/repo/${input.repoFullName}`;
          const commentBody =
            `🤖 Bando picked up this issue and is working on it.\n\n` +
            `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`)`;
          const postedBy = await postIssueCommentWithFallback(
            [{ token: botToken, source: "app-installation" }],
            input.repoFullName,
            issue.number,
            commentBody,
          );
          if (!postedBy) {
            console.warn(
              "[bandolier:deploy] failed to post issue comment — no usable token",
              { issue: issue.number },
            );
          }
        }

        return { jobName };
      } catch (err) {
        console.error("[bandolier:deploy] failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            err instanceof Error ? err.message : "Failed to deploy agent",
          cause: err,
        });
      }
    }),
});
