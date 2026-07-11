import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { cleanSessionToken, validateAwsCredentials } from "~/server/agents/aws";
import { validateAnthropicKey } from "~/server/agents/anthropic";
import {
  getRepoCustomProviders,
  normalizeCustomProviderInput,
  validateCustomProviderInput,
} from "~/server/agents/custom-providers";
import { gollmProviderInfo } from "~/server/agents/gollm-catalog";
import {
  summarizeGeminiCredentials,
  validateGeminiCredentials,
} from "~/server/agents/gemini";
import {
  repoArtifactStore,
  validateArtifactStore,
} from "~/server/agents/artifacts";
import { getUserGithubToken } from "~/server/agents/github-token";
import { validateOpenaiKey } from "~/server/agents/openai";
import { validateKubeconfig } from "~/server/agents/kubeconfig";
import { repoToNamespace } from "~/server/agents/namespace";
import {
  renderDefaultNetworkPolicyYaml,
  validateNetworkPolicyYaml,
} from "~/server/agents/network-policy";
import { isRepoAdmin } from "~/server/agents/github-repos";
import { parseComputeInput } from "~/server/agents/compute";
import { type Validation } from "~/server/agents/validation";
import { EFFORT_LEVELS } from "~/lib/effort";
import { HARNESS_CONTRACT_VERSION } from "~/lib/harness-contract";
import { type db } from "~/server/db";
import {
  repoCustomProviderCredentials,
  repoWebhookConfig,
  taskRun,
} from "~/server/db/schema";
import { maskKey, stripWhitespace } from "../credentials";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Upserts a partial set of columns onto a repo's config row, stamping who made
 * the change. Used by the credential mutations so each one can set just its own
 * fields without clobbering the rest.
 */
async function upsertRepoConfig(
  database: typeof db,
  repoFullName: string,
  userId: string,
  values: Partial<typeof repoWebhookConfig.$inferInsert>,
): Promise<void> {
  await database
    .insert(repoWebhookConfig)
    .values({ repoFullName, configuredBy: userId, ...values })
    .onConflictDoUpdate({
      target: repoWebhookConfig.repoFullName,
      set: { ...values, configuredBy: userId, updatedAt: new Date() },
    });
}

/**
 * Nulls a set of columns on a repo's config row, stamping who made the change.
 * Used by the credential `delete*` mutations, which differ only in which
 * columns they clear. Operates on the existing row (no upsert): with no config
 * row there's nothing to clear.
 */
async function clearRepoConfigColumns(
  database: typeof db,
  repoFullName: string,
  userId: string,
  columns: (keyof typeof repoWebhookConfig.$inferInsert)[],
): Promise<void> {
  const nulls = Object.fromEntries(columns.map((c) => [c, null]));
  await database
    .update(repoWebhookConfig)
    .set({ ...nulls, configuredBy: userId, updatedAt: new Date() })
    .where(eq(repoWebhookConfig.repoFullName, repoFullName));
}

/**
 * Loads the user's GitHub token and confirms they have admin on the repo —
 * required to view or change repo-scoped configuration. Throws otherwise.
 */
async function requireRepoAdmin(
  ctx: {
    db: Parameters<typeof getUserGithubToken>[0];
    session: { user: { id: string } };
  },
  repoFullName: string,
): Promise<void> {
  const token = await getUserGithubToken(ctx.db, ctx.session.user.id);
  if (!token) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "A linked GitHub account is required.",
    });
  }
  if (!(await isRepoAdmin(token, repoFullName))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "You need admin permission on this repository to change its configuration.",
    });
  }
}

/**
 * Builds the `set`/`delete` procedure pair for one repo-scoped credential. Every
 * setter is the same shape — require repo admin, validate the input, store the
 * columns (or reject with the validation error) — and every deleter just clears
 * a fixed column list, so the per-provider procedures differ only in their
 * schema, validator, and columns. `toResult` surfaces any success details the UI
 * shows (a cluster version, an STS ARN) alongside the `{ valid: true }` result.
 */
/**
 * Builds the `set<Name>`/`delete<Name>` procedure pair for one repo-scoped
 * credential, ready to spread into the router. Every setter is the same shape —
 * require repo admin, validate the input, store the columns (or reject with the
 * validation error) — and every deleter just clears a fixed column list, so the
 * per-provider procedures differ only in their schema, validator, and columns.
 * `toResult` surfaces any success details the UI shows (a cluster version, an
 * STS ARN) alongside the `{ valid: true }` result.
 */
/**
 * Builds the `set<Name>`/`delete<Name>` procedure pair for one repo-scoped
 * credential, ready to spread into the router. Every setter is the same shape —
 * require repo admin, validate the input, store the columns (or reject with the
 * validation error) — and every deleter just clears a fixed column list, so the
 * per-provider procedures differ only in their schema, validator, and columns.
 * `toResult` surfaces any success details the UI shows (a cluster version, an
 * STS ARN) alongside the `{ valid: true }` result.
 */
/**
 * Builds the `set<Name>`/`delete<Name>` procedure pair for one repo-scoped
 * credential, ready to spread into the router. Every setter is the same shape —
 * require repo admin, validate the input, store the columns (or reject with the
 * validation error) — and every deleter just clears a fixed column list, so the
 * per-provider procedures differ only in their schema, validator, and columns.
 * `toResult` surfaces any success details the UI shows (a cluster version, an
 * STS ARN) alongside the `{ valid: true }` result.
 */
function repoCredentialPair<
  Name extends string,
  TSchema extends z.ZodType<{ repoFullName: string }>,
  TValidation extends Validation,
  TResult extends Record<string, unknown> = Record<string, never>,
>(
  name: Name,
  config: {
    inputSchema: TSchema;
    validate: (input: z.infer<TSchema>) => Promise<TValidation> | TValidation;
    toColumns: (
      input: z.infer<TSchema>,
    ) => Partial<typeof repoWebhookConfig.$inferInsert>;
    clearColumns: (keyof typeof repoWebhookConfig.$inferInsert)[];
    invalidMessage: string;
    toResult?: (validation: Extract<TValidation, { valid: true }>) => TResult;
  },
) {
  const set = protectedProcedure
    .input(config.inputSchema)
    .mutation(async ({ ctx, input }) => {
      const parsed = input as z.infer<TSchema>;
      await requireRepoAdmin(ctx, parsed.repoFullName);
      const validation = await config.validate(parsed);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error || config.invalidMessage,
        });
      }
      await upsertRepoConfig(
        ctx.db,
        parsed.repoFullName,
        ctx.session.user.id,
        config.toColumns(parsed),
      );
      const extra = config.toResult?.(
        validation as Extract<TValidation, { valid: true }>,
      );
      return { valid: true as const, ...(extra ?? ({} as Partial<TResult>)) };
    });

  const del = protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await clearRepoConfigColumns(
        ctx.db,
        input.repoFullName,
        ctx.session.user.id,
        config.clearColumns,
      );
      return { success: true };
    });

  const cap = (name.charAt(0).toUpperCase() +
    name.slice(1)) as Capitalize<Name>;
  return {
    [`set${cap}`]: set,
    [`delete${cap}`]: del,
  } as Record<`set${Capitalize<Name>}`, typeof set> &
    Record<`delete${Capitalize<Name>}`, typeof del>;
}

export const webhooksRouter = createTRPCRouter({
  // Non-secret status of a repo's webhook/agent configuration.
  getConfig: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const [row] = await ctx.db
        .select({
          updatedAt: repoWebhookConfig.updatedAt,
          prefix: repoWebhookConfig.prefix,
          triggerOnAllEvents: repoWebhookConfig.triggerOnAllEvents,
          agentImage: repoWebhookConfig.agentImage,
          defaultWebhookModel: repoWebhookConfig.defaultWebhookModel,
          defaultWebhookEffort: repoWebhookConfig.defaultWebhookEffort,
          computeCpu: repoWebhookConfig.computeCpu,
          computeMemory: repoWebhookConfig.computeMemory,
          systemPrompt: repoWebhookConfig.systemPrompt,
          resumeOnCiFailure: repoWebhookConfig.resumeOnCiFailure,
          allowPrivateEgress: repoWebhookConfig.allowPrivateEgress,
          allowAllPortsEgress: repoWebhookConfig.allowAllPortsEgress,
          networkPolicyYaml: repoWebhookConfig.networkPolicyYaml,
          // Artifact-store columns, selected only to compute hasArtifactStore
          // below — the secrets themselves are never returned.
          artifactsS3Bucket: repoWebhookConfig.artifactsS3Bucket,
          artifactsS3Region: repoWebhookConfig.artifactsS3Region,
          artifactsS3Endpoint: repoWebhookConfig.artifactsS3Endpoint,
          artifactsAccessKeyId: repoWebhookConfig.artifactsAccessKeyId,
          artifactsSecretAccessKey: repoWebhookConfig.artifactsSecretAccessKey,
        })
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
        .limit(1);
      const allowPrivateEgress = row?.allowPrivateEgress ?? false;
      const allowAllPortsEgress = row?.allowAllPortsEgress ?? false;

      // Staleness signal for a custom agent image: the contract version the
      // most recent run on that exact image reported via the ingest callback.
      // Null when there's no custom image or no run on it has called back yet
      // (nothing to judge); 0 means a harness too old to report a version at
      // all. The UI warns when this is below HARNESS_CONTRACT_VERSION.
      let agentImageReportedContract: number | null = null;
      if (row?.agentImage) {
        const [latest] = await ctx.db
          .select({ harnessContract: taskRun.harnessContract })
          .from(taskRun)
          .where(
            and(
              eq(taskRun.repoFullName, input.repoFullName),
              eq(taskRun.agentImage, row.agentImage),
              isNotNull(taskRun.harnessContract),
            ),
          )
          .orderBy(desc(taskRun.updatedAt))
          .limit(1);
        agentImageReportedContract = latest?.harnessContract ?? null;
      }
      return {
        // Whether a config row exists at all (any setting saved).
        configured: !!row,
        updatedAt: row?.updatedAt ?? null,
        prefix: row?.prefix ?? "",
        // Whether webhook events always trigger agents, ignoring the prefix
        // (off unless a row turns it on; the default is to never trigger).
        triggerOnAllEvents: row?.triggerOnAllEvents ?? false,
        agentImage: row?.agentImage ?? "",
        // Whether the custom agent image looks out of date, judged by the last
        // run on it: reportedContract < current means the harness binary in
        // that image predates what this server expects of it.
        agentImageContract: {
          current: HARNESS_CONTRACT_VERSION,
          lastReported: agentImageReportedContract,
          outdated:
            agentImageReportedContract !== null &&
            agentImageReportedContract < HARNESS_CONTRACT_VERSION,
        },
        defaultWebhookModel: row?.defaultWebhookModel ?? null,
        defaultWebhookEffort: row?.defaultWebhookEffort ?? null,
        // Default agent compute for the repo ("" = none; fall through to the
        // user default, then the built-in limit).
        computeCpu: row?.computeCpu ?? "",
        computeMemory: row?.computeMemory ?? "",
        systemPrompt: row?.systemPrompt ?? "",
        // Whether a failing CI pipeline auto-resumes the run that produced the
        // PR (off unless a row turns it on).
        resumeOnCiFailure: row?.resumeOnCiFailure ?? false,
        // Whether the repo has a usable artifact store. Resume features (by
        // comment or by CI failure) require it — resumed runs are seeded with
        // the parent's persisted transcript — so the UI gates their controls
        // on this.
        hasArtifactStore: row ? repoArtifactStore(row) !== null : false,
        // Network-policy egress toggles (both off unless a row turns them on).
        allowPrivateEgress,
        allowAllPortsEgress,
        // Advanced: the repo's custom NetworkPolicy YAML ("" = none), plus the
        // policy the toggles would otherwise produce — the starting point the
        // UI seeds the raw-YAML editor with.
        networkPolicyYaml: row?.networkPolicyYaml ?? "",
        defaultNetworkPolicyYaml: renderDefaultNetworkPolicyYaml(
          repoToNamespace(input.repoFullName),
          { allowPrivateEgress, allowAllPortsEgress },
        ),
      };
    }),

  // Set the per-repo network-policy egress toggles. Both loosen the default
  // agent NetworkPolicy and are admin-only. SECURITY: enabling either trades
  // pod isolation for reach — the repo-config UI surfaces a warning. Partial
  // upsert so each toggle can be set without clobbering other config.
  setNetworkPolicy: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Allow egress to private / in-cluster (RFC-1918) ranges.
        allowPrivateEgress: z.boolean().optional(),
        // Allow egress on any TCP port instead of only 80/443.
        allowAllPortsEgress: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const values: Partial<typeof repoWebhookConfig.$inferInsert> = {};
      if (input.allowPrivateEgress !== undefined) {
        values.allowPrivateEgress = input.allowPrivateEgress;
      }
      if (input.allowAllPortsEgress !== undefined) {
        values.allowAllPortsEgress = input.allowAllPortsEgress;
      }
      await upsertRepoConfig(
        ctx.db,
        input.repoFullName,
        ctx.session.user.id,
        values,
      );
      return { success: true };
    }),

  // Set (or clear, with a blank string) the repo's custom NetworkPolicy YAML —
  // the advanced escape hatch that replaces the built-in agent policy (and the
  // egress toggles) entirely. Admin-only and validated structurally before it's
  // stored, so a broken policy is rejected at save time rather than failing
  // every subsequent deploy. SECURITY: a custom policy can open any egress the
  // cluster allows — the UI surfaces the same isolation warning as the toggles.
  setNetworkPolicyYaml: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Capped like the system prompt so a pathological document can't bloat
        // the config row; real policies are a few hundred bytes.
        yaml: z.string().max(20000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const yaml = input.yaml.trim() ? input.yaml : null;
      if (yaml) {
        const validation = validateNetworkPolicyYaml(yaml);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: validation.error,
          });
        }
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        networkPolicyYaml: yaml,
      });
      return { success: true };
    }),

  setConfig: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Optional trigger phrase; blank clears it (act on all events).
        prefix: z.string().optional(),
        // Optional agent harness image override; blank clears it (use default).
        agentImage: z.string().optional(),
        // Optional repo-attached system prompt: a blanket instruction appended to
        // the system prompt of every agent run for the repo, across dashboard,
        // issue, and webhook runs. Capped to keep it from bloating every job's
        // env; blank clears it.
        systemPrompt: z.string().max(10000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);

      const prefix = input.prefix?.trim() ? input.prefix.trim() : null;
      const agentImage = input.agentImage?.trim()
        ? input.agentImage.trim()
        : null;
      const systemPrompt = input.systemPrompt?.trim()
        ? input.systemPrompt.trim()
        : null;

      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        prefix,
        agentImage,
        systemPrompt,
      });
      return { success: true };
    }),

  // Set (or clear, with an empty string) the default model for webhook-triggered
  // agents. Partial upsert so it doesn't clobber other webhook config. Not
  // validated against the live model list here — selection re-checks availability
  // at trigger time and falls back to the provider default.
  setDefaultModel: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        model: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const value = input.model.trim() ? input.model.trim() : null;
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        defaultWebhookModel: value,
      });
      return { success: true };
    }),

  // Set (or clear, with an empty string) the default reasoning-effort level for
  // webhook-triggered Claude agents. Validated against the known levels; an
  // issue's `effort:<level>` label overrides it per issue, and it's ignored for
  // non-Claude providers. Partial upsert so it doesn't clobber other config.
  setDefaultEffort: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        // Empty string clears the default (fall back to the CLI default).
        effort: z.union([z.enum(EFFORT_LEVELS), z.literal("")]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const value = input.effort ? input.effort : null;
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        defaultWebhookEffort: value,
      });
      return { success: true };
    }),

  // Toggle whether webhook events always trigger agents, ignoring the trigger
  // prefix. Admin-only; off by default — without it (or a prefix) events never
  // trigger, since a fired event spends someone's credentials. Partial upsert
  // so it doesn't clobber other config.
  setTriggerOnAllEvents: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        triggerOnAllEvents: input.enabled,
      });
      return { success: true };
    }),

  // Toggle whether a failing CI pipeline auto-resumes the run that produced the
  // pull request it ran on (resumeable tasks). Admin-only; off by default since
  // it spends the run owner's credentials without a human in the loop. Partial
  // upsert so it doesn't clobber other config.
  setResumeOnCiFailure: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      // Enabling requires the repo's artifact store: a resumed run is seeded
      // with its parent's persisted transcript, and transcripts are only
      // persisted when the store (bucket + keys) is configured. Disabling is
      // always allowed, so a repo that later removes its store isn't stuck.
      if (input.enabled) {
        const [row] = await ctx.db
          .select({
            artifactsS3Bucket: repoWebhookConfig.artifactsS3Bucket,
            artifactsS3Region: repoWebhookConfig.artifactsS3Region,
            artifactsS3Endpoint: repoWebhookConfig.artifactsS3Endpoint,
            artifactsAccessKeyId: repoWebhookConfig.artifactsAccessKeyId,
            artifactsSecretAccessKey:
              repoWebhookConfig.artifactsSecretAccessKey,
          })
          .from(repoWebhookConfig)
          .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
          .limit(1);
        if (!row || repoArtifactStore(row) === null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Auto-resume needs the repo's artifact store (S3 bucket + keys) — resumed runs are seeded with the parent run's stored transcript. Configure artifact storage first.",
          });
        }
      }
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        resumeOnCiFailure: input.enabled,
      });
      return { success: true };
    }),

  // Set (or clear, with blank strings) the repo's default agent compute (CPU /
  // memory limit), applied to every run for the repo unless a per-task
  // override (deploy form, or an issue's `cpu:`/`memory:` label) or a
  // preferred user default wins. Validated as Kubernetes quantities; partial
  // upsert so it doesn't clobber other config.
  setDefaultCompute: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        cpu: z.string(),
        memory: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const { cpu, memory } = parseComputeInput(input.cpu, input.memory);
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        computeCpu: cpu,
        computeMemory: memory,
      });
      return { success: true };
    }),

  // ── Repo-scoped credentials (admin-only) ────────────────────────────────────
  // Shared kubeconfig + model credentials for everyone working on the repo. All
  // procedures require repo admin. SECURITY: these are shared infrastructure —
  // the UI warns admins to scope the cluster/keys to what the whole group should
  // be trusted with. Secrets are never returned to the client; only masked
  // status is.

  // Non-secret status of a repo's shared credentials plus the prefer toggle.
  getCredentials: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const [row] = await ctx.db
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
          artifactsS3Bucket: repoWebhookConfig.artifactsS3Bucket,
          artifactsS3Region: repoWebhookConfig.artifactsS3Region,
          artifactsS3Endpoint: repoWebhookConfig.artifactsS3Endpoint,
          artifactsAccessKeyId: repoWebhookConfig.artifactsAccessKeyId,
        })
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, input.repoFullName))
        .limit(1);
      const hasAws = !!row?.awsAccessKeyId && !!row.awsSecretAccessKey;
      return {
        hasKubeconfig: !!row?.kubeconfig,
        anthropic: row?.anthropicApiKey
          ? {
              configured: true as const,
              apiKeyMasked: maskKey(row.anthropicApiKey),
            }
          : { configured: false as const },
        openai: row?.openaiApiKey
          ? {
              configured: true as const,
              apiKeyMasked: maskKey(row.openaiApiKey),
            }
          : { configured: false as const },
        gemini: row?.geminiApiKey
          ? {
              configured: true as const,
              ...summarizeGeminiCredentials(row.geminiApiKey),
            }
          : { configured: false as const },
        aws: hasAws
          ? {
              configured: true as const,
              accessKeyIdMasked: maskKey(row.awsAccessKeyId!),
              region: row.awsRegion ?? "us-east-1",
              isTemporary: !!row.awsSessionToken,
            }
          : { configured: false as const },
        preferRepoCredentials: row?.preferRepoCredentials ?? false,
        artifacts: row?.artifactsS3Bucket
          ? {
              configured: true as const,
              bucket: row.artifactsS3Bucket,
              region: row.artifactsS3Region ?? "us-east-1",
              endpoint: row.artifactsS3Endpoint,
              accessKeyIdMasked: row.artifactsAccessKeyId
                ? maskKey(row.artifactsAccessKeyId)
                : null,
            }
          : { configured: false as const },
      };
    }),

  // Validate then store a repo-scoped kubeconfig.
  ...repoCredentialPair("kubeconfig", {
    inputSchema: z.object({
      repoFullName: z.string().min(1),
      kubeconfig: z.string().min(1),
    }),
    validate: (input) => validateKubeconfig(input.kubeconfig),
    toColumns: (input) => ({ kubeconfig: input.kubeconfig }),
    clearColumns: ["kubeconfig"],
    invalidMessage: "Kubeconfig is invalid.",
    toResult: (validation) => ({ version: validation.version }),
  }),

  // Validate then store a repo-scoped Anthropic API key.
  ...repoCredentialPair("anthropic", {
    inputSchema: z.object({
      repoFullName: z.string().min(1),
      // Strip ALL whitespace, not just the ends: a key pasted from a wrapped
      // terminal line arrives with interior spaces/newlines that survive trim().
      apiKey: stripWhitespace.pipe(z.string().min(1)),
    }),
    validate: (input) => validateAnthropicKey(input.apiKey),
    toColumns: (input) => ({ anthropicApiKey: input.apiKey }),
    clearColumns: ["anthropicApiKey"],
    invalidMessage: "Anthropic API key is invalid.",
  }),

  // Validate then store a repo-scoped OpenAI API key (used via the Codex CLI).
  ...repoCredentialPair("openai", {
    inputSchema: z.object({
      repoFullName: z.string().min(1),
      // Strip ALL whitespace, not just the ends: a key pasted from a wrapped
      // terminal line arrives with interior spaces/newlines that survive trim().
      apiKey: stripWhitespace.pipe(z.string().min(1)),
    }),
    validate: (input) => validateOpenaiKey(input.apiKey),
    toColumns: (input) => ({ openaiApiKey: input.apiKey }),
    clearColumns: ["openaiApiKey"],
    invalidMessage: "OpenAI API key is invalid.",
  }),

  // Validate then store repo-scoped Gemini project credentials (a Google Cloud
  // service-account key JSON, used via the Antigravity CLI).
  ...repoCredentialPair("gemini", {
    inputSchema: z.object({
      repoFullName: z.string().min(1),
      credentials: z.string().min(1),
    }),
    validate: (input) => validateGeminiCredentials(input.credentials),
    toColumns: (input) => ({ geminiApiKey: input.credentials }),
    clearColumns: ["geminiApiKey"],
    invalidMessage: "Gemini credentials are invalid.",
  }),

  // Validate then store repo-scoped AWS Bedrock credentials.
  ...repoCredentialPair("aws", {
    inputSchema: z.object({
      repoFullName: z.string().min(1),
      accessKeyId: z.string().trim().min(16),
      secretAccessKey: z.string().trim().min(1),
      sessionToken: z.string().optional().transform(cleanSessionToken),
      region: z.string().trim().min(1).default("us-east-1"),
    }),
    validate: (input) =>
      validateAwsCredentials({
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        sessionToken: input.sessionToken,
        region: input.region,
      }),
    toColumns: (input) => ({
      awsAccessKeyId: input.accessKeyId,
      awsSecretAccessKey: input.secretAccessKey,
      awsSessionToken: input.sessionToken ?? null,
      awsRegion: input.region,
    }),
    clearColumns: [
      "awsAccessKeyId",
      "awsSecretAccessKey",
      "awsSessionToken",
      "awsRegion",
    ],
    invalidMessage: "AWS credentials are invalid.",
    toResult: (validation) => ({ arn: validation.arn }),
  }),

  // Validate then store the repo's run-artifact store (an S3 bucket the repo
  // owns). This is the only place run transcripts (and, later, historical
  // context) can be persisted — there is deliberately no server-wide bucket —
  // so run data always lands in storage the repo controls. Credentials are
  // required — the server has no business reaching a repo-owned bucket through
  // its own ambient credentials — and should be scoped to just this bucket.
  // They stay server-side; they are never injected into agent pods.
  //
  // Clearing it (deleteArtifacts) leaves already-uploaded artifacts in the
  // repo's bucket (they're the repo's data); future runs are simply not
  // persisted until a new bucket is configured.
  ...repoCredentialPair("artifacts", {
    inputSchema: z.object({
      repoFullName: z.string().min(1),
      bucket: z.string().trim().min(1),
      region: z.string().trim().min(1).default("us-east-1"),
      // Custom endpoint for MinIO / S3-compatible stores; blank = AWS S3.
      endpoint: z.string().trim().optional(),
      accessKeyId: z.string().trim().min(1),
      secretAccessKey: z.string().trim().min(1),
    }),
    validate: (input) =>
      validateArtifactStore({
        bucket: input.bucket,
        region: input.region,
        // Blank endpoint means AWS S3 proper, not an empty custom endpoint.
        endpoint: input.endpoint === "" ? undefined : input.endpoint,
        credentials: {
          accessKeyId: input.accessKeyId,
          secretAccessKey: input.secretAccessKey,
        },
      }),
    toColumns: (input) => ({
      artifactsS3Bucket: input.bucket,
      artifactsS3Region: input.region,
      artifactsS3Endpoint:
        input.endpoint === "" ? null : (input.endpoint ?? null),
      artifactsAccessKeyId: input.accessKeyId,
      artifactsSecretAccessKey: input.secretAccessKey,
    }),
    clearColumns: [
      "artifactsS3Bucket",
      "artifactsS3Region",
      "artifactsS3Endpoint",
      "artifactsAccessKeyId",
      "artifactsSecretAccessKey",
    ],
    invalidMessage: "Artifact storage is unreachable.",
  }),

  // Toggle whether the repo's shared credentials win over a user's own when both
  // are set (applies to kubeconfig and model credentials alike).
  setPreferRepoCredentials: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        prefer: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await upsertRepoConfig(ctx.db, input.repoFullName, ctx.session.user.id, {
        preferRepoCredentials: input.prefer,
      });
      return { success: true };
    }),

  // ── Repo-shared gollm-proxied providers (admin-only) ──────────────────────
  // The repo counterpart of the user-scoped custom providers: every provider
  // gollm supports beyond the four first-class ones, shared across the repo and
  // governed by the same prefer-repo-credentials toggle.

  // The repo's configured custom providers, with the key masked.
  getCustomProviders: protectedProcedure
    .input(z.object({ repoFullName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const rows = await getRepoCustomProviders(ctx.db, input.repoFullName);
      return rows.map((row) => ({
        provider: row.provider,
        label: gollmProviderInfo(row.provider)?.label ?? row.provider,
        apiKeyMasked: row.apiKey ? maskKey(row.apiKey) : null,
        apiBase: row.apiBase,
        extraEnvKeys: Object.keys(row.extraEnv ?? {}),
        models: row.models ?? [],
      }));
    }),

  setCustomProvider: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        provider: z.string().min(1),
        /** The provider's declared field env vars → entered values. */
        fields: z.record(z.string(), z.string()),
        /** Comma/newline-separated model ids for non-listable providers. */
        models: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      const validation = await validateCustomProviderInput(input);
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.error || "Invalid provider credential.",
        });
      }
      const normalized = normalizeCustomProviderInput(input);
      await ctx.db
        .insert(repoCustomProviderCredentials)
        .values({ repoFullName: input.repoFullName, ...normalized })
        .onConflictDoUpdate({
          target: [
            repoCustomProviderCredentials.repoFullName,
            repoCustomProviderCredentials.provider,
          ],
          set: { ...normalized, updatedAt: new Date() },
        });
      return { valid: true as const };
    }),

  deleteCustomProvider: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().min(1),
        provider: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireRepoAdmin(ctx, input.repoFullName);
      await ctx.db
        .delete(repoCustomProviderCredentials)
        .where(
          and(
            eq(repoCustomProviderCredentials.repoFullName, input.repoFullName),
            eq(repoCustomProviderCredentials.provider, input.provider),
          ),
        );
      return { success: true };
    }),
});
