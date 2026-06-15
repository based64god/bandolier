import {
  BedrockClient,
  ListInferenceProfilesCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";

import { cleanSessionToken, type AwsCredentials } from "~/server/agents/aws";
import {
  pickProvider,
  resolveModelCredentials,
} from "~/server/agents/resolve-credentials";
import type { db } from "~/server/db";

export interface ModelOption {
  /** The id passed to the harness as CLAUDE_MODEL. */
  id: string;
  label: string;
}

export type ModelList =
  | { provider: "anthropic"; models: ModelOption[] }
  | { provider: "bedrock"; models: ModelOption[] }
  | { provider: "none"; models: [] };

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
  return body.data.map((m) => ({ id: m.id, label: m.display_name }));
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
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }

    // Fall back to on-demand foundation models.
    const models = await client.send(
      new ListFoundationModelsCommand({ byProvider: "Anthropic" }),
    );
    return (models.modelSummaries ?? [])
      .filter((m) => m.inferenceTypesSupported?.includes("ON_DEMAND"))
      .map((m) => ({ id: m.modelId!, label: m.modelName ?? m.modelId! }))
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
 * Lists the models available to a user from their configured provider's API.
 * AWS Bedrock takes precedence over an Anthropic key, mirroring deploy. When a
 * repo is given, repo-scoped credentials are considered alongside the user's own
 * per the repo's prefer-credentials flag.
 */
export async function listModelsForUser(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<ModelList> {
  const creds = await resolveModelCredentials(database, userId, repoFullName);
  const { aws, anthropicApiKey } = pickProvider(creds);
  if (aws) {
    return { provider: "bedrock", models: await listBedrockModels(aws) };
  }
  if (anthropicApiKey) {
    return {
      provider: "anthropic",
      models: await listAnthropicModels(anthropicApiKey),
    };
  }
  return { provider: "none", models: [] };
}

/** Picks a sensible default model id (prefers Sonnet) from a list. */
export function pickDefaultModel(models: ModelOption[]): string | undefined {
  const sonnet = models.find(
    (m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label),
  );
  return (sonnet ?? models[0])?.id;
}

/**
 * Picks the latest Sonnet model id from a provider's list. Used to write PR
 * titles/descriptions out-of-band of the task model — Sonnet is a good
 * speed/quality fit for summarizing a diff. "Latest" is decided by comparing the
 * numeric version tokens in the id (e.g. `claude-sonnet-4-6` > `claude-3-5-...`),
 * which works across both Anthropic ids and Bedrock inference-profile ids.
 * Returns undefined when the list has no Sonnet model.
 */
export function pickLatestSonnet(models: ModelOption[]): string | undefined {
  const sonnets = models.filter(
    (m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label),
  );
  if (sonnets.length === 0) return undefined;

  const version = (m: ModelOption): number[] =>
    (m.id.match(/\d+/g) ?? []).map(Number);

  return sonnets.reduce((best, m) => {
    const a = version(m);
    const b = version(best);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff > 0 ? m : best;
    }
    return best;
  }).id;
}
