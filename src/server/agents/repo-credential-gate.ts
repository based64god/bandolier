import { resolveKubeconfigWithSource } from "~/server/agents/kubeconfig";
import { resolveModelCredentials } from "~/server/agents/resolve-credentials";
import { type db } from "~/server/db";

/**
 * Whether a run for `repoFullName` by `userId` would draw on any repo-level
 * shared credential — the repo's kubeconfig or its AI API keys (Anthropic /
 * OpenAI / Gemini / AWS Bedrock). Such credentials are infrastructure trusted to
 * the whole repo, so a run that uses any of them must clear the maintainer bar
 * before it executes (dashboard deploys and webhook-triggered runs alike).
 *
 * A run that resolves entirely to the acting user's *own* credentials is not
 * gated — that user is only ever spending what's already theirs.
 *
 * Repo-less contexts (no `repoFullName`) can never use repo credentials, so this
 * is always false for them.
 */
export async function usesRepoCredentials(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<boolean> {
  if (!repoFullName) return false;

  // The credential set the model picker / deploy would actually use, tagged with
  // whether the repo's shared set won.
  const creds = await resolveModelCredentials(database, userId, repoFullName);
  if (creds.source === "repo") return true;

  // The kubeconfig is resolved independently of the model credentials, so a run
  // can land on the repo's shared cluster even when its model keys are the
  // user's own.
  const { source } = await resolveKubeconfigWithSource(
    database,
    userId,
    repoFullName,
  );
  return source === "repo";
}
