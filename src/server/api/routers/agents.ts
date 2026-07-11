import { randomUUID } from "crypto";

import { setHeaderOptions } from "@kubernetes/client-node";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { getArtifact, resolveArtifactStore } from "~/server/agents/artifacts";
import { validateAwsCredentials } from "~/server/agents/aws";
import { postIssueCommentWithFallback } from "~/server/agents/github-issues";
import {
  assertOwnsInteractiveJob,
  assertRepoAccess,
  ownedSelector,
  repoViewSelector,
  requireKubeconfig,
} from "~/server/agents/authz";
import {
  expiredRunToTask,
  loadExpiredRuns,
  loadPersistedOutputs,
  podJobName,
  podToTask,
} from "~/server/agents/task-view";
import {
  type ComputeSpec,
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEMORY_LIMIT,
} from "~/lib/compute";
import { EFFORT_LEVELS, providerSupportsEffort } from "~/lib/effort";
import { createAgentJob, DEFAULT_MAX_TURNS } from "~/server/agents/create-job";
import { getRepoBotToken } from "~/server/agents/github-app";
import { getUserGithubToken } from "~/server/agents/github-token";
import {
  mergeCompute,
  parseComputeInput,
  resolveCompute,
} from "~/server/agents/compute";
import { listModelsForUser, pickPrWriterModel } from "~/server/agents/models";
import {
  providerForCredentials,
  resolveModelCredentials,
  selectRunCredentials,
} from "~/server/agents/resolve-credentials";
import {
  assertMayUseRepoCredentials,
  loadRepoRunConfig,
  resolveGitIdentity,
  resolveIssueContext,
} from "~/server/agents/deploy-steps";
import { acpFrame, agentInput, taskRun } from "~/server/db/schema";
import { getBatchV1Api, getCoreV1Api } from "~/server/k8s/client";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Sentinel input message that tells the harness to end an interactive session
 * (close Claude's stdin and run the post-run PR step). Kept in sync with the Go
 * harness's matching constant.
 */
export const END_SESSION_SENTINEL = "__BANDOLIER_END_SESSION__";

/**
 * Rethrows a caught error as an INTERNAL_SERVER_ERROR, passing existing
 * TRPCErrors through unchanged so their code/message are preserved. Non-Error
 * causes fall back to `fallback` for the client-facing message. Pass `log` to
 * emit a console.error (with the underlying message) for non-TRPCError causes
 * before rethrowing.
 */
function rethrowAsInternal(
  err: unknown,
  fallback: string,
  log?: string,
): never {
  if (err instanceof TRPCError) throw err;
  if (log) {
    console.error(log, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : fallback,
    cause: err,
  });
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
      const provider = providerForCredentials(creds);
      if (!provider) {
        return {
          provider: "none" as const,
          region: null,
          source: "none" as const,
        };
      }
      return {
        provider,
        region: provider === "bedrock" ? (creds.aws?.region ?? null) : null,
        source: creds.source,
      };
    }),

  // Deploy-form defaults sourced from the server so the UI stays in sync.
  // The compute default is resolved per repo/user (see resolveCompute) so the
  // form can show what a task will run with unless overridden.
  deployDefaults: protectedProcedure
    .input(z.object({ repoFullName: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      await assertRepoAccess(ctx.db, ctx.session.user.id, input?.repoFullName);
      const compute = await resolveCompute(
        ctx.db,
        ctx.session.user.id,
        input?.repoFullName,
      );
      return {
        maxTurns: DEFAULT_MAX_TURNS,
        compute: {
          cpu: compute.cpu ?? DEFAULT_CPU_LIMIT,
          memory: compute.memory ?? DEFAULT_MEMORY_LIMIT,
        },
      };
    }),

  // Cross-repo overview for the home screen: every agent the acting user spawned,
  // regardless of repository (including repo-less tasks, and webhook tasks
  // triggered by the user's GitHub account). Permission is enforced by the label
  // selector — pods are tagged with their owner's id, so we ask Kubernetes only
  // for this user's pods rather than scanning every pod. Each row is the same
  // task view-model `list`/`get` build (podToTask), extended with `namespace`
  // so the home screen can link each task back to its repo view.
  overview: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const kubeconfig = await requireKubeconfig(ctx.db, userId);
    const githubToken = await getUserGithubToken(ctx.db, userId);
    const nowMs = Date.now();

    try {
      const res = await getCoreV1Api(kubeconfig).listPodForAllNamespaces({
        labelSelector: ownedSelector(userId),
      });

      // One batched query recovers persisted output for every terminal pod whose
      // logs are gone — rather than a lookup per pod.
      const persistedOutputs = await loadPersistedOutputs(ctx.db, res.items);

      const live = await Promise.all(
        res.items.map(async (pod) => {
          const namespace = pod.metadata?.namespace ?? "";
          const task = await podToTask(
            pod,
            namespace,
            kubeconfig,
            ctx.db,
            githubToken,
            nowMs,
            persistedOutputs,
            userId,
          );
          return { ...task, namespace };
        }),
      );

      // Runs whose pod the Job's TTL already deleted, recovered from the run
      // table so finished work (and its persisted transcript) stays listed.
      const expiredRuns = await loadExpiredRuns(ctx.db, {
        viewerId: userId,
        liveJobNames: res.items.map(podJobName),
      });
      const expired = await Promise.all(
        expiredRuns.map(async (run) => ({
          ...(await expiredRunToTask(run, ctx.db, githubToken, nowMs, userId)),
          namespace: run.namespace,
        })),
      );

      return [...live, ...expired];
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
        const live = await Promise.all(
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

        // Runs whose pod the Job's TTL already deleted, recovered from the run
        // table so finished work (and its persisted transcript) stays listed.
        // Same visibility as the pod query above (see loadExpiredRuns).
        const expiredRuns = await loadExpiredRuns(ctx.db, {
          viewerId: userId,
          namespace: input.namespace,
          repoFullName: input.repoFullName,
          liveJobNames: res.items.map(podJobName),
        });
        const expired = await Promise.all(
          expiredRuns.map((run) =>
            expiredRunToTask(run, ctx.db, githubToken, nowMs, userId),
          ),
        );

        return [...live, ...expired];
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
        rethrowAsInternal(err, "Failed to get task");
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
        rethrowAsInternal(err, "Failed to rename task");
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
        rethrowAsInternal(err, "Failed to terminate pod");
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
          // Reasoning effort for the run. Applies to every provider (all
          // runs drive the claude CLI). Optional — unset uses the CLI default.
          effort: z.enum(EFFORT_LEVELS).optional(),
          maxTurns: z
            .number()
            .int()
            .min(1)
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
          // Per-task compute (CPU / memory limit) override, as Kubernetes
          // quantities. Unset falls back to the repo/user default, then the
          // built-in limit. Validated in the handler for a readable error.
          cpu: z.string().optional(),
          memory: z.string().optional(),
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

      // Validate a per-task compute override up front, so a malformed quantity
      // is a clear 400 rather than a failed job creation.
      const parsed = parseComputeInput(input.cpu, input.memory);
      const computeOverride: ComputeSpec = {
        cpu: parsed.cpu ?? undefined,
        memory: parsed.memory ?? undefined,
      };

      // A repo's shared cluster and credentials are only for users who can reach
      // that repo. Verify access before resolving anything repo-scoped, so a
      // non-member can't deploy under another team's kubeconfig/cloud creds.
      await assertRepoAccess(ctx.db, userId, input.repoFullName);

      // Resolve the cluster: repo-scoped vs. the user's own per the repo's
      // prefer-credentials flag.
      const kubeconfig = await requireKubeconfig(
        ctx.db,
        userId,
        input.repoFullName,
      );

      // Resolve the run's compute the same way: the per-task override beats
      // the repo/user defaults (ordered by the prefer-credentials flag).
      const compute = mergeCompute(
        await resolveCompute(ctx.db, userId, input.repoFullName),
        computeOverride,
      );

      // Resolve model credentials, then select the exact set for this run: the
      // provider of the model the user chose (falling back to the primary-provider
      // precedence for REST/webhook clients with no picker), and — for Anthropic /
      // OpenAI, which the picker offers once per credential kind — the auth kind
      // they pinned (falling back to the API-key-beats-subscription precedence).
      const resolved = await resolveModelCredentials(
        ctx.db,
        userId,
        input.repoFullName,
      );
      const {
        provider,
        authKind,
        aws: awsCredentials,
        anthropicApiKey,
        anthropicOauthToken,
        openaiApiKey,
        codexAuthJson,
        geminiApiKey,
      } = selectRunCredentials(resolved, {
        modelProvider: input.modelProvider,
        modelAuth: input.modelAuth,
      });

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

        const { gitIdentity, githubLogin } = await resolveGitIdentity(
          githubToken,
          { name: ctx.session.user.name, email: ctx.session.user.email },
        );

        await assertMayUseRepoCredentials(
          ctx.db,
          userId,
          input.repoFullName,
          resolved,
          githubToken,
          githubLogin,
        );

        const { issue, task, displayName, agentBranch, systemPrompt } =
          await resolveIssueContext(
            githubToken,
            input.repoFullName,
            input.issueNumber,
            input.task,
            issueOutput,
          );

        // PR-producing runs (repo or issue mode) get their PR title/description
        // written out-of-band of the (possibly larger) task model by a cheap
        // same-provider writer (the latest Sonnet / GPT mini / Flash), picked
        // only from the models the run's resolved credentials serve — a
        // subscription run must never be handed a dated API-key model id it
        // can't invoke. Best-effort: a lookup failure falls back to the
        // harness's commit-based title and must not block the deploy.
        let prWriterModel: string | undefined;
        if (provider && (repoUrl ?? issue ?? issueOutput)) {
          try {
            const { models } = await listModelsForUser(
              ctx.db,
              userId,
              input.repoFullName,
            );
            prWriterModel = pickPrWriterModel(models, {
              id: input.model,
              label: input.model,
              provider,
              // The auth kind the run's credentials actually resolved to (the
              // API key beats the subscription), from selectRunCredentials.
              auth: authKind ?? undefined,
            });
          } catch (err) {
            console.warn("[bandolier:deploy] PR-writer model lookup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const { agentImage, imagePullSecret, repoSystemPrompt, networkPolicy } =
          await loadRepoRunConfig(ctx.db, input.repoFullName, githubToken);

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
          // Effort applies wherever the provider has a reasoning knob;
          // providerSupportsEffort is the single opt-out point.
          effort:
            provider && providerSupportsEffort(provider)
              ? input.effort
              : undefined,
          maxTurns: input.maxTurns,
          compute,
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
        rethrowAsInternal(
          err,
          "Failed to deploy agent",
          "[bandolier:deploy] failed",
        );
      }
    }),
});
