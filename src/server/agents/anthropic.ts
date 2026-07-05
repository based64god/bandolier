import { eq } from "drizzle-orm";

import { probeApiKey, type Validation } from "~/server/agents/validation";
import { type db } from "~/server/db";
import { userAnthropicCredentials } from "~/server/db/schema";

export type AnthropicValidation = Validation;

/**
 * Validates an Anthropic API key with a cheap, token-free GET /v1/models call.
 * A 401 means the key is bad; 200 means it works.
 */
export function validateAnthropicKey(
  apiKey: string,
): Promise<AnthropicValidation> {
  return probeApiKey(
    "https://api.anthropic.com/v1/models?limit=1",
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    "Anthropic",
  );
}

// Claude subscription OAuth tokens from `claude setup-token` look like
// "sk-ant-oat01-…". They only work through the Claude Code CLI (not the plain
// Messages API), so validation is a format check; a bad token fails at run time.
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";

/**
 * Validates the shape of a Claude Code OAuth token (`claude setup-token`).
 * OAuth tokens are scoped to Claude Code and can't be probed against the
 * Anthropic API, so this is a format check only. Interior whitespace and
 * out-of-charset bytes are rejected: a token copied from a wrapped terminal
 * line picks up spaces/newlines that survive an ends-only trim, and the CLI
 * then sends the mangled value as a legal-but-wrong bearer header — the
 * failure only surfaces as a runtime "401 Invalid bearer token".
 */
export function validateAnthropicOauthToken(
  token: string,
): AnthropicValidation {
  if (!token.startsWith(OAUTH_TOKEN_PREFIX)) {
    return {
      valid: false,
      error: `Token should start with "${OAUTH_TOKEN_PREFIX}" — run \`claude setup-token\` and paste the result.`,
    };
  }
  if (/\s/.test(token)) {
    return {
      valid: false,
      error:
        "Token contains whitespace — it was probably split across lines when copied from the terminal. Re-copy it as one unbroken line and save it again.",
    };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return {
      valid: false,
      error:
        "Token contains unexpected characters — run `claude setup-token` and paste the result.",
    };
  }
  if (token.length < OAUTH_TOKEN_PREFIX.length + 20) {
    return { valid: false, error: "Token looks truncated." };
  }
  return { valid: true };
}

/** A user's Claude credentials: exactly one of the fields is set (or neither). */
export interface AnthropicCredentials {
  apiKey: string | null;
  /** Claude subscription OAuth token from `claude setup-token`. */
  oauthToken: string | null;
}

/** Loads a user's stored Anthropic credentials (API key or OAuth token). */
export async function getUserAnthropicCredentials(
  database: typeof db,
  userId: string,
): Promise<AnthropicCredentials> {
  const [row] = await database
    .select({
      apiKey: userAnthropicCredentials.apiKey,
      oauthToken: userAnthropicCredentials.oauthToken,
    })
    .from(userAnthropicCredentials)
    .where(eq(userAnthropicCredentials.userId, userId))
    .limit(1);
  return { apiKey: row?.apiKey ?? null, oauthToken: row?.oauthToken ?? null };
}
