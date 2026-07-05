import { validateAwsCredentials } from "~/server/agents/aws";
import { type JobSpec } from "~/server/agents/create-job";
import { mergeCompute, resolveCompute } from "~/server/agents/compute";
import { getGithubAccountByGithubId } from "~/server/agents/github-token";
import { resolveKubeconfig } from "~/server/agents/kubeconfig";
import {
  fuzzyPickModel,
  listModelsForUser,
  pickDefaultModel,
  pickPrWriterModel,
} from "~/server/agents/models";
import {
  resolveModelCredentials,
  selectRunCredentials,
} from "~/server/agents/resolve-credentials";
import { db } from "~/server/db";
import { parseCpuQuery, parseMemoryQuery } from "~/lib/compute";
import { parseEffortQuery, providerSupportsEffort } from "~/lib/effort";

import {
  CPU_LABEL_PREFIX,
  EFFORT_LABEL_PREFIX,
  labelQuery,
  MEMORY_LABEL_PREFIX,
  MODEL_LABEL_PREFIX,
} from "./labels";

/**
 * The subset of a `JobSpec` that a webhook run's prerequisites already
 * determine, regardless of what triggered it: the chosen model, its reasoning
 * effort and compute, the provider credentials (only the selected provider's
 * are set), the kubeconfig, and the out-of-band PR-writer model. Handlers
 * spread this and extend it with the trigger-specific fields (task, branch,
 * display name, git identity, …).
 */
export type WebhookRunSpec = Pick<
  JobSpec,
  | "model"
  | "effort"
  | "compute"
  | "prWriterModel"
  | "kubeconfig"
  | "awsCredentials"
  | "anthropicApiKey"
  | "anthropicOauthToken"
  | "openaiApiKey"
  | "codexAuthJson"
  | "geminiApiKey"
>;

export interface ResolvedWebhookRun {
  /** The Bandolier user linked to the GitHub account that triggered the event. */
  linked: { userId: string; accessToken: string | null };
  /** The chosen model id, hoisted out of `specBase` for logging convenience. */
  model: string;
  /** Ready-made spec fields the handlers spread into their `JobSpec`. */
  specBase: WebhookRunSpec;
  /**
   * The full credential-resolution result, so callers judging credential
   * provenance (e.g. the repo-credentials maintainer gate) don't re-resolve.
   */
  resolved: Awaited<ReturnType<typeof resolveModelCredentials>>;
}

/**
 * Everything a webhook-triggered run needs that doesn't depend on what
 * triggered it: the Bandolier user linked to the sender, the model (label →
 * repo default → provider default), the reasoning effort, the credentials for
 * the chosen provider (AWS validated up front), the kubeconfig, and the
 * out-of-band PR-writer model. Returns null — with the reason logged under
 * `logCtx` — when any prerequisite is missing, so callers just skip the event.
 */
export async function resolveWebhookRun(opts: {
  sender: { id: number; login: string };
  repoFullName: string;
  /** Labels considered for `model:` / `effort:` selection (the issue's). */
  labels: { name: string }[];
  defaultModel: string | null;
  defaultEffort: string | null;
  logCtx: Record<string, unknown>;
}): Promise<ResolvedWebhookRun | null> {
  const { sender, repoFullName, labels, logCtx } = opts;

  // Only user-provided credentials are ever used. Resolve the Bandolier user
  // linked to the GitHub account that triggered the event; skip if none.
  const linked = await getGithubAccountByGithubId(db, String(sender.id));
  if (!linked) {
    console.log("[bandolier:webhook] skipped — sender not a Bandolier user", {
      ...logCtx,
      sender: sender.login,
    });
    return null;
  }

  // Resolve the sender's model credentials (considering this repo's shared
  // credentials per its prefer-credentials flag) and list the models they unlock
  // — across every configured provider, Claude and OpenAI alike.
  const resolved = await resolveModelCredentials(
    db,
    linked.userId,
    repoFullName,
  );
  const { models } = await listModelsForUser(db, linked.userId, repoFullName);
  if (models.length === 0) {
    console.log(
      "[bandolier:webhook] skipped — sender has no model credentials",
      { ...logCtx, sender: sender.login },
    );
    return null;
  }

  // Choose the model. Precedence:
  //   1. An issue label like `model:<query>` fuzzy-selects (e.g. model:opus →
  //      the latest Claude Opus), letting the author pick per issue.
  //   2. The repo's configured default webhook model, when still available.
  //   3. The provider's sensible default (prefers Sonnet).
  const modelQuery = labelQuery(labels, MODEL_LABEL_PREFIX);
  let model: string | undefined;
  if (modelQuery) {
    model = fuzzyPickModel(modelQuery, models);
    console.log(
      model
        ? "[bandolier:webhook] model selected from issue label"
        : "[bandolier:webhook] no model matched issue label",
      { ...logCtx, label: `${MODEL_LABEL_PREFIX}${modelQuery}`, model },
    );
  }
  if (!model && opts.defaultModel) {
    model = models.find((m) => m.id === opts.defaultModel)?.id;
    if (model) {
      console.log("[bandolier:webhook] model selected from repo default", {
        ...logCtx,
        model,
      });
    }
  }
  model ??= pickDefaultModel(models);
  if (!model) {
    console.log("[bandolier:webhook] skipped — no models available", {
      ...logCtx,
      sender: sender.login,
    });
    return null;
  }

  // Route credentials by the chosen model's provider (mirrors the deploy path).
  // A model is only ever listed when its provider's credentials resolved, so the
  // matching set is present here.
  const selectedModel = models.find((m) => m.id === model);
  const provider = selectedModel?.provider;

  // Resolve the reasoning effort, but only for a Claude provider — the OpenAI and
  // Gemini CLIs don't take it. Precedence mirrors the model's: an `effort:<level>`
  // label overrides the repo's configured default; an unknown label value is
  // ignored (falls through to the default, then the CLI default).
  let effort: string | undefined;
  if (provider && providerSupportsEffort(provider)) {
    const effortQuery = labelQuery(labels, EFFORT_LABEL_PREFIX);
    const labelEffort = effortQuery ? parseEffortQuery(effortQuery) : undefined;
    const repoEffort = opts.defaultEffort
      ? parseEffortQuery(opts.defaultEffort)
      : undefined;
    effort = labelEffort ?? repoEffort;
    if (effortQuery && !labelEffort) {
      console.log("[bandolier:webhook] no effort matched issue label", {
        ...logCtx,
        label: `${EFFORT_LABEL_PREFIX}${effortQuery}`,
      });
    } else if (effort) {
      console.log("[bandolier:webhook] effort selected", {
        ...logCtx,
        effort,
        source: labelEffort ? "issue label" : "repo default",
      });
    }
  }

  // Resolve the run's compute (CPU / memory limit). Precedence mirrors the
  // model's: a `cpu:<qty>` / `memory:<qty>` issue label overrides the
  // repo/user default (resolveCompute orders those by the repo's
  // prefer-credentials flag); an invalid label value is ignored with a log.
  const cpuQuery = labelQuery(labels, CPU_LABEL_PREFIX);
  const memoryQuery = labelQuery(labels, MEMORY_LABEL_PREFIX);
  const labelCpu = cpuQuery ? parseCpuQuery(cpuQuery) : undefined;
  const labelMemory = memoryQuery ? parseMemoryQuery(memoryQuery) : undefined;
  if (cpuQuery && !labelCpu) {
    console.log("[bandolier:webhook] invalid cpu issue label ignored", {
      ...logCtx,
      label: `${CPU_LABEL_PREFIX}${cpuQuery}`,
    });
  }
  if (memoryQuery && !labelMemory) {
    console.log("[bandolier:webhook] invalid memory issue label ignored", {
      ...logCtx,
      label: `${MEMORY_LABEL_PREFIX}${memoryQuery}`,
    });
  }
  const compute = mergeCompute(
    await resolveCompute(db, linked.userId, repoFullName),
    { cpu: labelCpu, memory: labelMemory },
  );
  if (compute) {
    console.log("[bandolier:webhook] compute selected", {
      ...logCtx,
      ...compute,
      source:
        (labelCpu ?? labelMemory)
          ? "issue label + defaults"
          : "repo/user default",
    });
  }

  // Select the run's credentials by the chosen model's provider (mirrors the
  // deploy path). No modelAuth here — the webhook picks by provider and lets the
  // API key beat the subscription, which selectRunCredentials does by default.
  const {
    aws: awsCredentials,
    anthropicApiKey,
    anthropicOauthToken,
    openaiApiKey,
    codexAuthJson,
    geminiApiKey,
  } = selectRunCredentials(resolved, { modelProvider: provider });
  if (
    !awsCredentials &&
    !anthropicApiKey &&
    !anthropicOauthToken &&
    !openaiApiKey &&
    !codexAuthJson &&
    !geminiApiKey
  ) {
    console.log(
      "[bandolier:webhook] skipped — no credentials for the selected model",
      { ...logCtx, sender: sender.login, model },
    );
    return null;
  }

  // Validate AWS credentials so we don't spawn a pod that can't authenticate.
  if (awsCredentials) {
    const validation = await validateAwsCredentials(awsCredentials);
    if (!validation.valid) {
      console.log(
        "[bandolier:webhook] skipped — sender's AWS credentials invalid",
        { ...logCtx, sender: sender.login, error: validation.error },
      );
      return null;
    }
  }

  const kubeconfig = await resolveKubeconfig(db, linked.userId, repoFullName);
  if (!kubeconfig) {
    console.log("[bandolier:webhook] skipped — no repo or sender kubeconfig", {
      ...logCtx,
      sender: sender.login,
    });
    return null;
  }

  // Out-of-band PR writer from the same provider AND credential kind as the chosen
  // model (the latest Sonnet for Claude, GPT mini for OpenAI, Flash for Gemini),
  // picked only from the models the job's own credentials serve.
  const prWriterModel = pickPrWriterModel(models, selectedModel);

  return {
    linked,
    model,
    specBase: {
      model,
      effort,
      compute,
      prWriterModel,
      kubeconfig,
      awsCredentials: awsCredentials ?? undefined,
      anthropicApiKey: anthropicApiKey ?? undefined,
      anthropicOauthToken: anthropicOauthToken ?? undefined,
      openaiApiKey: openaiApiKey ?? undefined,
      codexAuthJson: codexAuthJson ?? undefined,
      geminiApiKey: geminiApiKey ?? undefined,
    },
    resolved,
  };
}
