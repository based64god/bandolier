import { setHeaderOptions, type V1Pod } from "@kubernetes/client-node";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { getUserAnthropicKey } from "~/server/agents/anthropic";
import { getArtifact } from "~/server/agents/artifacts";
import { validateAwsCredentials } from "~/server/agents/aws";
import { getIssue } from "~/server/agents/github-issues";
import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import { buildIssuePrompt, makeIssueBranch } from "~/lib/issue-prompt";
import {
  createAgentJob,
  DEFAULT_MAX_TURNS,
  JOB_TTL_SECONDS,
} from "~/server/agents/create-job";
import { getUserGithubToken } from "~/server/agents/github-token";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
import { taskRun } from "~/server/db/schema";
import { getBatchV1Api, getCoreV1Api } from "~/server/k8s/client";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const LABEL_SELECTOR = env.K8S_LABEL_SELECTOR;

const PR_MARKER = /PR_URL=(https:\/\/\S+)/;

interface PodInspection {
  /** The most recent assistant (non-harness) line — what Claude is doing now. */
  currently: string | null;
  /** The pull-request URL the harness logged, if any. */
  pullRequestUrl: string | null;
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
    let currently: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line && !line.includes("[harness]")) {
        currently = line;
        break;
      }
    }

    const result: PodInspection = {
      currently,
      pullRequestUrl: PR_MARKER.exec(logs)?.[1] ?? null,
    };
    if (terminal) terminalInspectionCache.set(podName, result);
    return result;
  } catch {
    return { currently: null, pullRequestUrl: null }; // transient; retry next poll
  }
}

/** Resolves the server-wide or user kubeconfig, throwing if neither is set. */
async function requireKubeconfig(
  db: Parameters<typeof resolveKubeconfig>[0],
  userId: string,
): Promise<string> {
  const kubeconfig = await resolveKubeconfig(db, userId);
  if (!kubeconfig) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No kubeconfig configured. Add one in settings to manage agents.",
    });
  }
  return kubeconfig;
}

/** Maps a pod into the task shape returned by `list`/`get` (reads logs once). */
async function podToTask(pod: V1Pod, namespace: string, kubeconfig: string) {
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

  const { currently, pullRequestUrl } = await inspectPod(
    name,
    namespace,
    status,
    kubeconfig,
  );

  const containerEnv = pod.spec?.containers?.[0]?.env ?? [];
  const prompt =
    containerEnv.find((e) => e.name === "CLAUDE_TASK")?.value ?? null;

  return {
    name,
    jobName: pod.metadata?.labels?.["bandolier.io/job"] ?? name,
    repoFullName: annotations["bandolier.io/repo"] ?? null,
    displayName: annotations["bandolier.io/display-name"] ?? name,
    prompt,
    source: pod.metadata?.labels?.["bandolier.io/source"] ?? "dashboard",
    issueNumber: annotations["bandolier.io/github-issue"] ?? null,
    issueUrl: annotations["bandolier.io/issue-url"] ?? null,
    createdBy: annotations["bandolier.io/created-by"] ?? null,
    status,
    currently,
    expiresAt,
    pullRequestUrl,
  };
}

export const agentsRouter = createTRPCRouter({
  // Reports the acting user's own configured provider (AWS Bedrock takes
  // precedence over an Anthropic key). Only user credentials are ever used.
  providerInfo: protectedProcedure.query(async ({ ctx }) => {
    const aws = await getUserAwsCredentials(ctx.db, ctx.session.user.id);
    if (aws) {
      return { provider: "bedrock" as const, region: aws.region };
    }
    const anthropic = await getUserAnthropicKey(ctx.db, ctx.session.user.id);
    if (anthropic) {
      return { provider: "anthropic" as const, region: null };
    }
    return { provider: "none" as const, region: null };
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
          const { pullRequestUrl } = await inspectPod(
            name,
            namespace,
            status,
            kubeconfig,
          );

          return {
            name,
            namespace,
            repoFullName: annotations["bandolier.io/repo"] ?? null,
            displayName: annotations["bandolier.io/display-name"] ?? name,
            source:
              pod.metadata?.labels?.["bandolier.io/source"] ?? "dashboard",
            issueNumber: annotations["bandolier.io/github-issue"] ?? null,
            issueUrl: annotations["bandolier.io/issue-url"] ?? null,
            createdBy: annotations["bandolier.io/created-by"] ?? null,
            status,
            pullRequestUrl,
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
    .input(z.object({ namespace: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const kubeconfig = await requireKubeconfig(ctx.db, ctx.session.user.id);
      try {
        const res = await getCoreV1Api(kubeconfig).listNamespacedPod({
          namespace: input.namespace,
          labelSelector: LABEL_SELECTOR,
        });
        return await Promise.all(
          res.items.map((pod) => podToTask(pod, input.namespace, kubeconfig)),
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
      }),
    )
    .query(async ({ input, ctx }) => {
      const kubeconfig = await requireKubeconfig(ctx.db, ctx.session.user.id);
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
        return await podToTask(pod, input.namespace, kubeconfig);
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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const kubeconfig = await requireKubeconfig(ctx.db, ctx.session.user.id);
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
        // The modal grows this as the user scrolls up to load older lines.
        tailLines: z.number().int().min(10).max(10000).default(200),
      }),
    )
    .query(async ({ input, ctx }) => {
      const kubeconfig = await requireKubeconfig(ctx.db, ctx.session.user.id);
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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const kubeconfig = await requireKubeconfig(ctx.db, ctx.session.user.id);
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
          // A model id from the user's provider (see models.list).
          model: z.string().min(1),
          maxTurns: z.number().int().min(1).max(200).optional(),
          // When set, the agent works on this GitHub issue (and the task field
          // becomes additional context).
          issueNumber: z.number().int().positive().optional(),
          gitName: z.string().optional(),
          gitEmail: z.string().email().optional(),
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

      console.log("[bandolier:deploy] starting", {
        namespace: input.namespace,
        model: input.model,
        repo: repoUrl ?? null,
        task:
          input.task.length > 80 ? `${input.task.slice(0, 80)}…` : input.task,
        user: ctx.session?.user?.email ?? "unknown",
      });

      const userId = ctx.session.user.id;

      // Agents run in the user's own cluster — no server fallback.
      const kubeconfig = await requireKubeconfig(ctx.db, userId);

      // Resolve the user's own model credentials — there is no server fallback.
      const awsCredentials = await getUserAwsCredentials(ctx.db, userId);
      const anthropicApiKey = awsCredentials
        ? null
        : await getUserAnthropicKey(ctx.db, userId);

      if (!awsCredentials && !anthropicApiKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "No model credentials configured. Add AWS Bedrock or an Anthropic API key in settings before deploying.",
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

        // For an issue: generate a unique working branch and build the full
        // prompt here (with the operator's task as additional context) so it's
        // stored as CLAUDE_TASK and visible in the dashboard.
        const agentBranch = issue
          ? makeIssueBranch(issue.number, issue.title)
          : undefined;
        const task =
          issue && agentBranch
            ? buildIssuePrompt(issue, agentBranch, input.task)
            : input.task;

        const jobName = await createAgentJob({
          namespace: input.namespace,
          task,
          agentBranch,
          displayName,
          repoUrl,
          repoFullName: input.repoFullName,
          branch: input.branch,
          model: input.model,
          maxTurns: input.maxTurns,
          issueNumber: issue ? String(issue.number) : undefined,
          issueUrl: issue?.url,
          userId,
          githubToken: githubToken ?? undefined,
          awsCredentials: awsCredentials ?? undefined,
          anthropicApiKey: anthropicApiKey ?? undefined,
          kubeconfig,
          createdBy: ctx.session.user.name ?? ctx.session.user.email,
          gitName: input.gitName ?? ctx.session.user.name,
          gitEmail: input.gitEmail ?? ctx.session.user.email,
        });
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
