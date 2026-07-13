import {
  BedrockClient,
  ListInferenceProfilesCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";

import {
  cleanSessionToken,
  friendlyAwsError,
  type AwsCredentials,
} from "~/server/agents/aws";
import {
  listCustomProviderModels,
  gollmProviderName,
} from "~/server/agents/custom-providers";
import { listGeminiModels as fetchGeminiModels } from "~/server/agents/gemini";
import {
  gollmProviderInfo,
  parseGollmProvider,
} from "~/server/agents/gollm-catalog";
import { listOpenaiModels as fetchOpenaiModels } from "~/server/agents/openai";
import {
  type RunProviderName,
  resolveModelCredentials,
} from "~/server/agents/resolve-credentials";
import type { db } from "~/server/db";

/** Which provider a model is served by — used to label it and to route the
 * deploy to the right credentials. Aliases the provider registry's
 * `RunProviderName` (the four first-class providers plus `gollm:<id>` for the
 * proxied ones) so the union is defined in exactly one place. */
export type ModelProvider = RunProviderName;

export interface ModelOption {
  /** The id passed to the harness as CLAUDE_MODEL. */
  id: string;
  label: string;
  /** The provider this model is served by. */
  provider: ModelProvider;
  /**
   * Which credential kind serves this model, for providers that support both a
   * metered API key and a subscription login (Anthropic, OpenAI). Shown in the
   * picker so a user with both configured can see which set a run will use —
   * the API key (or Bedrock) takes precedence when both are set. Unset for
   * Bedrock/Gemini, which have a single credential kind.
   */
  auth?: "api_key" | "subscription";
}

/**
 * The flat list of models a user can pick from, drawn from every provider they
 * have credentials for (the Claude side — Bedrock or Anthropic by precedence —
 * plus OpenAI). Each entry carries its `provider` so the UI can label its source
 * and the deploy can route to the right credentials.
 */
export interface ModelList {
  models: ModelOption[];
}

// ── Anthropic ──────────────────────────────────────────────────────────────

interface AnthropicModel {
  id: string;
  display_name: string;
}

async function listAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${res.statusText}`);
  }
  const body = (await res.json()) as { data: AnthropicModel[] };
  return body.data.map((m) => ({
    id: m.id,
    label: m.display_name,
    provider: "anthropic" as const,
    auth: "api_key" as const,
  }));
}

/**
 * The Claude models offered to Claude-subscription (OAuth token) users. OAuth
 * tokens from `claude setup-token` are scoped to the Claude Code CLI and can't
 * call GET /v1/models, so the picker uses this static list of current models.
 */
const SUBSCRIPTION_ANTHROPIC_MODELS: ModelOption[] = (
  [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ] as const
).map((m) => ({
  ...m,
  provider: "anthropic" as const,
  auth: "subscription" as const,
}));

/**
 * The models a ChatGPT subscription serves through the Codex backend (which
 * the harness's embedded model proxy speaks). A pasted auth.json holds OAuth
 * session tokens that can't call GET /v1/models, so the picker uses this
 * static list. Keep in sync with the ChatGPT/Codex model set
 * (https://developers.openai.com/codex/models).
 */
const SUBSCRIPTION_CODEX_MODELS: ModelOption[] = (
  [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  ] as const
).map((m) => ({
  ...m,
  provider: "openai" as const,
  auth: "subscription" as const,
}));

// ── OpenAI ─────────────────────────────────────────────────────────────────

async function listOpenaiModels(apiKey: string): Promise<ModelOption[]> {
  const models = await fetchOpenaiModels(apiKey);
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    provider: "openai" as const,
    auth: "api_key" as const,
  }));
}

// ── Gemini ─────────────────────────────────────────────────────────────────

async function listGeminiModels(apiKey: string): Promise<ModelOption[]> {
  const models = await fetchGeminiModels(apiKey);
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    provider: "gemini" as const,
  }));
}

// ── Bedrock ────────────────────────────────────────────────────────────────

// Claude models on Bedrock are typically invoked through cross-region inference
// profiles, so prefer those; fall back to on-demand foundation models.
async function listBedrockModels(
  creds: AwsCredentials,
): Promise<ModelOption[]> {
  const client = new BedrockClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: cleanSessionToken(creds.sessionToken),
    },
    maxAttempts: 2,
  });

  try {
    const profiles = await client.send(
      new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" }),
    );
    const claudeProfiles = (profiles.inferenceProfileSummaries ?? []).filter(
      (p) => /anthropic|claude/i.test(p.inferenceProfileId ?? ""),
    );
    if (claudeProfiles.length > 0) {
      return claudeProfiles
        .map((p) => ({
          id: p.inferenceProfileId!,
          label: p.inferenceProfileName ?? p.inferenceProfileId!,
          provider: "bedrock" as const,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }

    // Fall back to on-demand foundation models.
    const models = await client.send(
      new ListFoundationModelsCommand({ byProvider: "Anthropic" }),
    );
    return (models.modelSummaries ?? [])
      .filter((m) => m.inferenceTypesSupported?.includes("ON_DEMAND"))
      .map((m) => ({
        id: m.modelId!,
        label: m.modelName ?? m.modelId!,
        provider: "bedrock" as const,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    throw new Error(friendlyAwsError(err, "bedrock"));
  } finally {
    client.destroy();
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Lists every model a user can pick from, combining all the providers they have
 * credentials for into one flat, source-labelled list. The Claude side follows
 * the deploy precedence (Bedrock beats an Anthropic key); OpenAI models are
 * listed alongside it when an OpenAI key is configured. When a repo is given,
 * repo-scoped credentials are considered alongside the user's own per the repo's
 * prefer-credentials flag.
 */
export async function listModelsForUser(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<ModelList> {
  const creds = await resolveModelCredentials(database, userId, repoFullName);

  // Fetch each configured provider concurrently. On the metered side, Bedrock
  // beats an Anthropic key (two routes to the same models); OpenAI and Gemini
  // are independent. Subscription credentials are listed ALONGSIDE the metered
  // set — the picker offers the same model once per credential kind, tagged via
  // `auth`, so a user with both can pin a run to either (e.g. subscription
  // quota for personal runs, the API key for work).
  const tasks: { provider: string; run: Promise<ModelOption[]> }[] = [];
  if (creds.aws)
    tasks.push({ provider: "bedrock", run: listBedrockModels(creds.aws) });
  else if (creds.anthropicApiKey)
    tasks.push({
      provider: "anthropic",
      run: listAnthropicModels(creds.anthropicApiKey),
    });
  if (creds.anthropicOauthToken)
    // Subscription OAuth tokens only work through the Claude Code CLI, not the
    // models API, so the picker gets a static list of current Claude models.
    tasks.push({
      provider: "anthropic",
      run: Promise.resolve(SUBSCRIPTION_ANTHROPIC_MODELS),
    });
  if (creds.openaiApiKey)
    tasks.push({
      provider: "openai",
      run: listOpenaiModels(creds.openaiApiKey),
    });
  if (creds.codexAuthJson)
    // Same for ChatGPT-subscription auth: no models endpoint, static list.
    tasks.push({
      provider: "openai",
      run: Promise.resolve(SUBSCRIPTION_CODEX_MODELS),
    });
  if (creds.geminiApiKey)
    tasks.push({
      provider: "gemini",
      run: listGeminiModels(creds.geminiApiKey),
    });
  // gollm-proxied providers: an OpenAI-compatible GET /models where the
  // catalog knows one, else (or on failure) the user-supplied model list.
  for (const custom of creds.customProviders ?? []) {
    const provider = gollmProviderName(custom.provider);
    // Subscription-style backends (GitHub Copilot) badge their models like the
    // Anthropic/OpenAI subscription options.
    const auth = gollmProviderInfo(custom.provider)?.subscription
      ? ("subscription" as const)
      : undefined;
    tasks.push({
      provider,
      run: listCustomProviderModels(custom).then((models) =>
        models.map((m) => ({ ...m, provider, ...(auth ? { auth } : {}) })),
      ),
    });
  }

  // Providers are independent: one provider's API failing (e.g. an expired key or
  // a transient outage) must not blank out the others, so settle each on its own
  // and keep the successes. A failure is logged and skipped.
  const settled = await Promise.allSettled(tasks.map((t) => t.run));
  const models: ModelOption[] = [];
  const failures: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      models.push(...result.value);
    } else {
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      failures.push(`${tasks[i]!.provider}: ${message}`);
      console.warn("[bandolier:models] provider model list failed", {
        provider: tasks[i]!.provider,
        error: message,
      });
    }
  });

  // If every configured provider failed, surface the error rather than returning
  // an empty list — which callers can't distinguish from "no credentials" and
  // would silently show an empty picker / skip a webhook.
  if (models.length === 0 && failures.length > 0) {
    throw new Error(`Failed to list models — ${failures.join("; ")}`);
  }
  return { models };
}

/** Picks a sensible default model id (prefers Sonnet) from a list. */
export function pickDefaultModel(models: ModelOption[]): string | undefined {
  const sonnet = models.find(
    (m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label),
  );
  return (sonnet ?? models[0])?.id;
}

/**
 * Returns the id of the "latest" model among `matches`, deciding by comparing
 * the numeric version tokens in each id left to right (e.g. `claude-sonnet-4-6` >
 * `claude-3-5-…`, `gpt-5-mini` > `gpt-4.1-mini`). Returns undefined for an empty
 * list. Shared by the per-family pickers below.
 */
function latestByVersion(matches: ModelOption[]): string | undefined {
  if (matches.length === 0) return undefined;

  const version = (m: ModelOption): number[] =>
    (m.id.match(/\d+/g) ?? []).map(Number);

  return matches.reduce((best, m) => {
    const a = version(m);
    const b = version(best);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff > 0 ? m : best;
    }
    return best;
  }).id;
}

/**
 * Picks the latest Sonnet model id from a list. Used to write PR
 * titles/descriptions out-of-band of the task model — Sonnet is a good
 * speed/quality fit for summarizing a diff. Works across both Anthropic ids and
 * Bedrock inference-profile ids. Returns undefined when the list has no Sonnet.
 */
export function pickLatestSonnet(models: ModelOption[]): string | undefined {
  return latestByVersion(
    models.filter((m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label)),
  );
}

/**
 * The OpenAI analogue of `pickLatestSonnet`: the latest GPT "mini" model, used as
 * the cheap out-of-band PR writer for OpenAI task runs. Returns undefined when
 * the list has no GPT mini model.
 */
export function pickLatestGptMini(models: ModelOption[]): string | undefined {
  return latestByVersion(
    models.filter((m) => m.provider === "openai" && /gpt.*mini/i.test(m.id)),
  );
}

/**
 * The Gemini analogue of `pickLatestSonnet`/`pickLatestGptMini`: the latest
 * Gemini "flash" model, used as the cheap out-of-band PR writer for Gemini task
 * runs. Returns undefined when the list has no Gemini flash model.
 */
export function pickLatestGeminiFlash(
  models: ModelOption[],
): string | undefined {
  return latestByVersion(
    models.filter((m) => m.provider === "gemini" && /flash/i.test(m.id)),
  );
}

// Cheap-model name markers used to pick a gollm PR writer — the catalog has no
// per-provider family heuristic, so fall back to models whose id/label advertises
// a small/fast variant. Bounded tokens so a general chat model isn't misread.
const CHEAP_MODEL =
  /(?:^|[-_/.:])(?:mini|flash|small|lite|nano|tiny|haiku|instant)(?:[-_/.:]|$)/i;

/**
 * The gollm analogue of the per-family pickers: the latest obviously-cheaper
 * model in a list (a "mini"/"flash"/"small"/… variant). Used to write PR copy
 * out-of-band of the task model for gollm-proxied runs. Returns undefined when
 * the list has no such model (the harness then uses the task model itself).
 */
export function pickCheapModel(models: ModelOption[]): string | undefined {
  return latestByVersion(
    models.filter((m) => CHEAP_MODEL.test(m.id) || CHEAP_MODEL.test(m.label)),
  );
}

/**
 * Picks the out-of-band PR-writer model for a run: the cheap same-provider model
 * that writes the PR title/description from the commits — the latest Sonnet for
 * Claude, the latest GPT mini for OpenAI, the latest Flash for Gemini.
 *
 * It is chosen ONLY from the models the run's own credentials serve: the same
 * provider as `selected`, and — where a provider exposes both a metered API key
 * and a subscription login (Anthropic, OpenAI) — the same `auth` kind. The
 * harness invokes the writer with the very credentials that provision the job, so
 * a subscription run must never be handed a dated API-key model id it can't
 * invoke (nor an API-key run a subscription-only alias). Picking across the whole
 * merged list let such a mismatch through and made `claude --model …` fail with
 * an unknown-model error, so PR copy generation silently fell back to the
 * baseline. Returns undefined when no matching writer model exists.
 */
export function pickPrWriterModel(
  models: ModelOption[],
  selected: ModelOption | undefined,
): string | undefined {
  if (!selected) return undefined;
  const candidates = models.filter(
    (m) =>
      m.provider === selected.provider &&
      (m.auth === undefined || m.auth === selected.auth),
  );
  // gollm-proxied providers: pick a cheaper same-provider model where the
  // listing advertises one; else undefined and the harness writes PR copy with
  // the task model itself. Same provider ⇒ same credentials, so any of its
  // models is invocable.
  if (parseGollmProvider(selected.provider)) return pickCheapModel(candidates);
  switch (selected.provider) {
    case "openai":
      return pickLatestGptMini(candidates);
    case "gemini":
      return pickLatestGeminiFlash(candidates);
    default:
      return pickLatestSonnet(candidates);
  }
}

/**
 * Fuzzy-resolves a free-text query (e.g. from a `model:<query>` issue label) to a
 * concrete model id: every model whose id or label contains the query
 * (case-insensitive) is a candidate, and the latest by version wins. So `opus` →
 * the latest Claude Opus, `gpt-5` → the latest GPT-5, `mini` → the latest mini.
 * Returns undefined when nothing matches.
 */
export function fuzzyPickModel(
  query: string,
  models: ModelOption[],
): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return latestByVersion(
    models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
    ),
  );
}


/**
 * Resolves a free-text provider query (e.g. from a `provider:<value>` issue
 * label) to one of the providers present in `models`. Matches the provider tag
 * exactly (`bedrock`, `anthropic`, `gollm:groq`), or a gollm catalog id without
 * the prefix (`groq` → `gollm:groq`), case-insensitively. Returns undefined when
 * no available provider matches — the caller then falls back to the model's own
 * provider.
 */
export function matchProviderQuery(
  query: string,
  models: ModelOption[],
): ModelProvider | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const providers = [...new Set(models.map((m) => m.provider))];
  return (
    providers.find((p) => p.toLowerCase() === q) ??
    providers.find((p) => p.toLowerCase() === `gollm:${q}`)
  );
}
