import { getUserAnthropicCredentials } from "~/server/agents/anthropic";
import type { AwsCredentials } from "~/server/agents/aws";
import { getUserGeminiKey } from "~/server/agents/gemini";
import { getUserOpenaiCredentials } from "~/server/agents/openai";
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
  /** Claude subscription OAuth token (`claude setup-token`) — user-scoped only. */
  anthropicOauthToken: string | null;
  openaiApiKey: string | null;
  /** ChatGPT-subscription auth.json (`codex login`) — user-scoped only. */
  codexAuthJson: string | null;
  geminiApiKey: string | null;
  /** Where the credentials came from — useful for logging / UI. */
  source: "user" | "repo" | "none";
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
  const userAnthropic = await getUserAnthropicCredentials(database, userId);
  const userOpenai = await getUserOpenaiCredentials(database, userId);
  const userGemini = await getUserGeminiKey(database, userId);
  const userHas =
    !!userAws ||
    !!userAnthropic.apiKey ||
    !!userAnthropic.oauthToken ||
    !!userOpenai.apiKey ||
    !!userOpenai.codexAuthJson ||
    !!userGemini;

  const repo = repoFullName
    ? await getRepoCredentials(database, repoFullName)
    : null;
  const repoAws = repo?.aws ?? null;
  const repoAnthropic = repo?.anthropicApiKey ?? null;
  const repoOpenai = repo?.openaiApiKey ?? null;
  const repoGemini = repo?.geminiApiKey ?? null;
  const repoHas = !!repoAws || !!repoAnthropic || !!repoOpenai || !!repoGemini;

  // AWS Bedrock, an Anthropic key, and a Claude subscription OAuth token are
  // all routes to the same (Claude) models with a precedence between them, so
  // they move as one unit: a repo set must never mix the repo's AWS with the
  // user's Anthropic (or vice versa). Subscription credentials are personal, so
  // repos only ever hold API keys.
  const repoHasClaude = !!repoAws || !!repoAnthropic;
  // Same for the OpenAI side: an API key and a ChatGPT auth.json are two routes
  // to the same models, so the repo's key must not mix with the user's auth.json.
  const repoHasOpenai = !!repoOpenai;

  const userSet: ModelCredentials = {
    aws: userAws,
    anthropicApiKey: userAnthropic.apiKey,
    anthropicOauthToken: userAnthropic.oauthToken,
    openaiApiKey: userOpenai.apiKey,
    codexAuthJson: userOpenai.codexAuthJson,
    geminiApiKey: userGemini,
    source: userHas ? "user" : "none",
  };
  const repoSet: ModelCredentials = {
    // Claude side as one coherent unit: the repo's Claude set when it has one,
    // else fall back to the user's whole Claude set — never a mix of the two.
    aws: repoHasClaude ? repoAws : userAws,
    anthropicApiKey: repoHasClaude ? repoAnthropic : userAnthropic.apiKey,
    anthropicOauthToken: repoHasClaude ? null : userAnthropic.oauthToken,
    // OpenAI side likewise; Gemini is a single-credential provider and falls
    // back to the user's own key on its own.
    openaiApiKey: repoHasOpenai ? repoOpenai : userOpenai.apiKey,
    codexAuthJson: repoHasOpenai ? null : userOpenai.codexAuthJson,
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
 * Bedrock beats Anthropic credentials (API key or subscription OAuth token),
 * which beat OpenAI credentials (API key or ChatGPT auth.json). At most one
 * provider's fields are non-null. The interactive deploy path instead routes by
 * the provider of the model the user actually picked.
 */
export function pickProvider(creds: ModelCredentials): {
  aws: AwsCredentials | null;
  anthropicApiKey: string | null;
  anthropicOauthToken: string | null;
  openaiApiKey: string | null;
  codexAuthJson: string | null;
  geminiApiKey: string | null;
} {
  const none = {
    aws: null,
    anthropicApiKey: null,
    anthropicOauthToken: null,
    openaiApiKey: null,
    codexAuthJson: null,
    geminiApiKey: null,
  };
  if (creds.aws) return { ...none, aws: creds.aws };
  if (creds.anthropicApiKey || creds.anthropicOauthToken)
    return {
      ...none,
      anthropicApiKey: creds.anthropicApiKey,
      anthropicOauthToken: creds.anthropicOauthToken,
    };
  if (creds.openaiApiKey || creds.codexAuthJson)
    return {
      ...none,
      openaiApiKey: creds.openaiApiKey,
      codexAuthJson: creds.codexAuthJson,
    };
  return { ...none, geminiApiKey: creds.geminiApiKey };
}
