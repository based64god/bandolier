import { getUserAnthropicKey } from "~/server/agents/anthropic";
import type { AwsCredentials } from "~/server/agents/aws";
import { getUserGeminiKey } from "~/server/agents/gemini";
import { getUserOpenaiKey } from "~/server/agents/openai";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import type { db } from "~/server/db";

/**
 * A resolved set of model credentials. AWS Bedrock, an Anthropic key, and an
 * OpenAI key may all be present; callers that need a single provider apply the
 * AWS-beats-Anthropic precedence themselves (see `pickProvider`), while the model
 * picker lists every configured provider's models side by side.
 *
 * OpenAI is user-scoped only — there is no repo-shared OpenAI credential — so it
 * only ever appears on the user's own set.
 */
export interface ModelCredentials {
  aws: AwsCredentials | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  geminiApiKey: string | null;
  /** Where the credentials came from — useful for logging / UI. */
  source: "user" | "repo" | "none";
}

function hasAny(
  aws: AwsCredentials | null,
  anthropic: string | null,
  openai: string | null = null,
  gemini: string | null = null,
): boolean {
  return !!aws || !!anthropic || !!openai || !!gemini;
}

/**
 * Resolves which model credentials an agent should use. The unit of choice is
 * the whole set (so a user's AWS keys are never mixed with a repo's Anthropic
 * key): when the repo prefers its own credentials and has some, the repo set
 * wins; otherwise the user's own set wins, falling back to the other when the
 * preferred side is empty.
 *
 * `repoFullName` is optional — omit it for repo-less contexts, which then only
 * consider the user's own credentials.
 */
export async function resolveModelCredentials(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<ModelCredentials> {
  const userAws = await getUserAwsCredentials(database, userId);
  const userAnthropic = await getUserAnthropicKey(database, userId);
  const userOpenai = await getUserOpenaiKey(database, userId);
  const userGemini = await getUserGeminiKey(database, userId);
  const userHas = hasAny(userAws, userAnthropic, userOpenai, userGemini);

  const repo = repoFullName
    ? await getRepoCredentials(database, repoFullName)
    : null;
  const repoAws = repo?.aws ?? null;
  const repoAnthropic = repo?.anthropicApiKey ?? null;
  const repoOpenai = repo?.openaiApiKey ?? null;
  const repoGemini = repo?.geminiApiKey ?? null;
  const repoHas = hasAny(repoAws, repoAnthropic, repoOpenai, repoGemini);

  // AWS Bedrock and Anthropic are two routes to the same (Claude) models with a
  // precedence between them, so they move as one unit: a repo set must never mix
  // the repo's AWS with the user's Anthropic (or vice versa).
  const repoHasClaude = !!repoAws || !!repoAnthropic;

  const userSet: ModelCredentials = {
    aws: userAws,
    anthropicApiKey: userAnthropic,
    openaiApiKey: userOpenai,
    geminiApiKey: userGemini,
    source: userHas ? "user" : "none",
  };
  const repoSet: ModelCredentials = {
    // Claude side as one coherent unit: the repo's Claude set when it has one,
    // else fall back to the user's whole Claude set — never a mix of the two.
    aws: repoHasClaude ? repoAws : userAws,
    anthropicApiKey: repoHasClaude ? repoAnthropic : userAnthropic,
    // OpenAI and Gemini are independent providers (no shared models, no
    // precedence), so each falls back to the user's own key on its own.
    openaiApiKey: repoOpenai ?? userOpenai,
    geminiApiKey: repoGemini ?? userGemini,
    source: repoHas ? "repo" : "none",
  };

  if (repo?.preferRepoCredentials) {
    return repoHas ? repoSet : userSet;
  }
  return userHas ? userSet : repoSet;
}

/**
 * Collapses a credential set to a single primary provider for callers that need
 * one (webhook/REST deploys with no model picker, and the provider badge): AWS
 * Bedrock beats an Anthropic key, which beats an OpenAI key. Exactly one of the
 * returned fields is non-null. The interactive deploy path instead routes by the
 * provider of the model the user actually picked.
 */
export function pickProvider(creds: ModelCredentials): {
  aws: AwsCredentials | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  geminiApiKey: string | null;
} {
  if (creds.aws)
    return {
      aws: creds.aws,
      anthropicApiKey: null,
      openaiApiKey: null,
      geminiApiKey: null,
    };
  if (creds.anthropicApiKey)
    return {
      aws: null,
      anthropicApiKey: creds.anthropicApiKey,
      openaiApiKey: null,
      geminiApiKey: null,
    };
  if (creds.openaiApiKey)
    return {
      aws: null,
      anthropicApiKey: null,
      openaiApiKey: creds.openaiApiKey,
      geminiApiKey: null,
    };
  return {
    aws: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    geminiApiKey: creds.geminiApiKey,
  };
}
