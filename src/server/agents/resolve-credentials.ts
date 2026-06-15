import { getUserAnthropicKey } from "~/server/agents/anthropic";
import type { AwsCredentials } from "~/server/agents/aws";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import type { db } from "~/server/db";

/**
 * A resolved set of model credentials. AWS Bedrock and an Anthropic key may both
 * be present; callers that need a single provider apply the AWS-beats-Anthropic
 * precedence themselves (see `pickProvider`).
 */
export interface ModelCredentials {
  aws: AwsCredentials | null;
  anthropicApiKey: string | null;
  /** Where the credentials came from — useful for logging / UI. */
  source: "user" | "repo" | "none";
}

function hasAny(aws: AwsCredentials | null, anthropic: string | null): boolean {
  return !!aws || !!anthropic;
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
  const userHas = hasAny(userAws, userAnthropic);

  const repo = repoFullName
    ? await getRepoCredentials(database, repoFullName)
    : null;
  const repoAws = repo?.aws ?? null;
  const repoAnthropic = repo?.anthropicApiKey ?? null;
  const repoHas = hasAny(repoAws, repoAnthropic);

  const userSet: ModelCredentials = {
    aws: userAws,
    anthropicApiKey: userAnthropic,
    source: userHas ? "user" : "none",
  };
  const repoSet: ModelCredentials = {
    aws: repoAws,
    anthropicApiKey: repoAnthropic,
    source: repoHas ? "repo" : "none",
  };

  if (repo?.preferRepoCredentials) {
    return repoHas ? repoSet : userSet;
  }
  return userHas ? userSet : repoSet;
}

/**
 * Collapses a credential set to a single provider, mirroring deploy: AWS Bedrock
 * takes precedence over an Anthropic key. The returned `anthropicApiKey` is null
 * whenever AWS credentials are present.
 */
export function pickProvider(creds: ModelCredentials): {
  aws: AwsCredentials | null;
  anthropicApiKey: string | null;
} {
  if (creds.aws) return { aws: creds.aws, anthropicApiKey: null };
  return { aws: null, anthropicApiKey: creds.anthropicApiKey };
}
