import { randomUUID } from "crypto";

import { setHeaderOptions, type V1Pod } from "@kubernetes/client-node";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { getArtifact } from "~/server/agents/artifacts";
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
import {
  createAgentJob,
  DEFAULT_MAX_TURNS,
  JOB_TTL_SECONDS,
} from "~/server/agents/create-job";
import { getRepoBotToken } from "~/server/agents/github-app";
import {
  getGithubIdentity,
  getUserGithubToken,
  githubGitIdentity,
  type GitIdentity,
} from "~/server/agents/github-token";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
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
import { getRepoAgentImage } from "~/server/agents/webhook-config";
import { type db } from "~/server/db";
import { agentInput, taskRun } from "~/server/db/schema";
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
}

// Terminal pods' logs are immutable, so their inspection is cached. Running pods
// are always re-read so "currently" stays live.
const terminalInspectionCache = new Map<string, PodInspection>();

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
  const cached = terminalInspectionCache.get(podName);
  if (terminal && cached) return cached;

  try {
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

    const result: PodInspection = {
      currently,
      pullRequestUrl: PR_MARKER.exec(logs)?.[1] ?? null,
      createdIssueUrl: ISSUE_MARKER.exec(logs)?.[1] ?? null,
      awaitingInput: !terminal && lastAwait >= 0 && lastAwait > lastResume,
    };
    if (terminal) terminalInspectionCache.set(podName, result);
    return result;
  } catch {
    // transient; retry next poll
    return {
      currently: null,
      pullRequestUrl: null,
      createdIssueUrl: null,
      awaitingInput: false,
    };
  }
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

/** Maps a pod into the task shape returned by `list`/`get` (reads logs once). */
async function podToTask(
  pod: V1Pod,
  namespace: string,
  kubeconfig: string,
  database: typeof db,
  userGithubToken: string | null,
  nowMs: number,
) {
  const annotations = pod.metadata?.annotations ?? {};
  const name = pod.metadata?.name ?? "unknown";
  const status = pod.status?.phase ?? "Unknown";

  // The Job's TTL deletes it JOB_TTL_SECONDS after the harness container
  // finishes, so expiry = finishedAt + TTL. Null while running.
  const finishedAt =
    pod.status?.containerStatuses?.[0]?.state?.terminated?.finishedAt;
  const expiresAt = finishedAt
    ? new Date(
      new Date(finishedAt).getTime() + JOB_TTL_SECONDS * 1000,
    ).toISOString()
    : null;

  const { currently, pullRequestUrl, createdIssueUrl, awaitingInput } =
    await inspectPod(name, namespace, status, kubeconfig);

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
    jobName: pod.metadata?.labels?.["bandolier.io/job"] ?? name,
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
      const { aws, anthropicApiKey, openaiApiKey, geminiApiKey } =
        pickProvider(creds);
      if (aws) {
        return {
          provider: "bedrock" as const,
          region: aws.region,
          source: creds.source,
        };
      }
      if (anthropicApiKey) {
        return {
          provider: "anthropic" as const,
          region: null,
          source: creds.source,
        };
      }
      if (openaiApiKey) {
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

      return await Promise.all(
        res.items.map(async (pod) => {
          const annotations = pod.metadata?.annotations ?? {};
          const name = pod.metadata?.name ?? "unknown";
          const namespace = pod.metadata?.namespace ?? "";
          const status = pod.status?.phase ?? "Unknown";

          // The pull-request URL lives in the harness logs; read it per pod
          // (cheap here — only the user's own agents, and terminal pods cache).
          const { pullRequestUrl, createdIssueUrl, awaitingInput } =
            await inspectPod(name, namespace, status, kubeconfig);
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
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        ctx.session.user.id,
        input.repoFullName,
      );
      const githubToken = await getUserGithubToken(ctx.db, ctx.session.user.id);
      const nowMs = Date.now();
      try {
        const res = await getCoreV1Api(kubeconfig).listNamespacedPod({
          namespace: input.namespace,
          labelSelector: LABEL_SELECTOR,
        });
        return await Promise.all(
          res.items.map((pod) =>
            podToTask(
              pod,
              input.namespace,
              kubeconfig,
              ctx.db,
              githubToken,
              nowMs,
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
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        ctx.session.user.id,
        input.repoFullName,
      );
      try {
        const res = await getCoreV1Api(kubeconfig).listNamespacedPod({
          namespace: input.namespace,
          labelSelector: `${LABEL_SELECTOR},bandolier.io/job=${input.jobName}`,
        });
        const pod = res.items[0];
        if (!pod) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Task ${input.jobName} not found`,
          });
        }
        const githubToken = await getUserGithubToken(
          ctx.db,
          ctx.session.user.id,
        );
        return await podToTask(
          pod,
          input.namespace,
          kubeconfig,
          ctx.db,
          githubToken,
          Date.now(),
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
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        ctx.session.user.id,
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
        await getBatchV1Api(kubeconfig).patchNamespacedJob(
          { name: input.jobName, namespace: input.namespace, body },
          merge,
        );
        const pods = await core.listNamespacedPod({
          namespace: input.namespace,
          labelSelector: `${LABEL_SELECTOR},bandolier.io/job=${input.jobName}`,
        });
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
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        ctx.session.user.id,
        input.repoFullName,
      );
      try {
        return await getCoreV1Api(kubeconfig).readNamespacedPodLog({
          name: input.podName,
          namespace: input.namespace,
          container: input.container,
          tailLines: input.tailLines,
        });
      } catch (err) {
        // Pod likely deleted after its TTL — serve the persisted transcript.
        const jobName = input.jobName;
        if (jobName) {
          const [run] = await ctx.db
            .select({ transcriptKey: taskRun.transcriptKey })
            .from(taskRun)
            .where(eq(taskRun.jobName, jobName))
            .limit(1);
          if (run?.transcriptKey) {
            const transcript = await getArtifact(run.transcriptKey);
            if (transcript !== null) return transcript;
          }
        }
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            err instanceof Error ? err.message : "Failed to get pod logs",
          cause: err,
        });
      }
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
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        ctx.session.user.id,
        input.repoFullName,
      );
      try {
        await getCoreV1Api(kubeconfig).deleteNamespacedPod({
          name: input.podName,
          namespace: input.namespace,
        });
        return { success: true };
      } catch (err) {
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
          : resolved.anthropicApiKey
            ? "anthropic"
            : resolved.openaiApiKey
              ? "openai"
              : resolved.geminiApiKey
                ? "gemini"
                : undefined);

      const awsCredentials =
        provider === "bedrock" ? (resolved.aws ?? primary.aws) : null;
      const anthropicApiKey =
        provider === "anthropic"
          ? (resolved.anthropicApiKey ?? primary.anthropicApiKey)
          : null;
      const openaiApiKey =
        provider === "openai"
          ? (resolved.openaiApiKey ?? primary.openaiApiKey)
          : null;
      const geminiApiKey =
        provider === "gemini"
          ? (resolved.geminiApiKey ?? primary.geminiApiKey)
          : null;

      if (
        !awsCredentials &&
        !anthropicApiKey &&
        !openaiApiKey &&
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
        if (githubToken) {
          try {
            const gh = await getGithubIdentity(githubToken);
            gitIdentity = githubGitIdentity(gh.id, gh.login);
          } catch (err) {
            console.warn("[bandolier:deploy] GitHub identity lookup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
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
        // when unset). Best-effort: a lookup failure must not block the deploy.
        let agentImage: string | undefined;
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
          openaiApiKey: openaiApiKey ?? undefined,
          geminiApiKey: geminiApiKey ?? undefined,
          kubeconfig,
          agentImage: agentImage ?? undefined,
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
