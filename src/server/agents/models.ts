import {
  BedrockClient,
  ListInferenceProfilesCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";

import { cleanSessionToken, type AwsCredentials } from "~/server/agents/aws";
import { listGeminiModels as fetchGeminiModels } from "~/server/agents/gemini";
import { listOpenaiModels as fetchOpenaiModels } from "~/server/agents/openai";
import { resolveModelCredentials } from "~/server/agents/resolve-credentials";
import type { db } from "~/server/db";

/** Which provider a model is served by — used to label it and to route the
 * deploy to the right credentials. */
export type ModelProvider = "anthropic" | "bedrock" | "openai" | "gemini";

export interface ModelOption {
  /** The id passed to the harness as CLAUDE_MODEL. */
  id: string;
  label: string;
  /** The provider this model is served by. */
  provider: ModelProvider;
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
  }));
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

async function listOpenaiModels(apiKey: string): Promise<ModelOption[]> {
  const models = await fetchOpenaiModels(apiKey);
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    provider: "openai" as const,
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
    throw new Error(friendlyAwsError(err));
  } finally {
    client.destroy();
  }
}

/** Maps AWS SDK error names to clear, user-facing messages. */
function friendlyAwsError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  switch (e.name) {
    case "ExpiredTokenException":
    case "ExpiredToken":
      return "AWS credentials have expired. Update them in settings.";
    case "InvalidSignatureException":
    case "UnrecognizedClientException":
      return "AWS credentials are invalid. Check them in settings.";
    case "AccessDeniedException":
      return "AWS credentials lack permission to list Bedrock models (bedrock:ListInferenceProfiles / ListFoundationModels).";
    default:
      return e.message ?? "Failed to query AWS Bedrock models.";
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

  // Fetch each configured provider concurrently. The Claude side is one provider
  // (Bedrock beats an Anthropic key); OpenAI and Gemini are independent.
  const tasks: { provider: string; run: Promise<ModelOption[]> }[] = [];
  if (creds.aws)
    tasks.push({ provider: "bedrock", run: listBedrockModels(creds.aws) });
  else if (creds.anthropicApiKey)
    tasks.push({
      provider: "anthropic",
      run: listAnthropicModels(creds.anthropicApiKey),
    });
  if (creds.openaiApiKey)
    tasks.push({
      provider: "openai",
      run: listOpenaiModels(creds.openaiApiKey),
    });
  if (creds.geminiApiKey)
    tasks.push({
      provider: "gemini",
      run: listGeminiModels(creds.geminiApiKey),
    });

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
