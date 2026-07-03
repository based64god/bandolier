import { eq } from "drizzle-orm";

import { type db } from "~/server/db";
import { userAnthropicCredentials } from "~/server/db/schema";

export interface AnthropicValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validates an Anthropic API key with a cheap, token-free GET /v1/models call.
 * A 401 means the key is bad; 200 means it works.
 */
export async function validateAnthropicKey(
  apiKey: string,
): Promise<AnthropicValidation> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401)
      return { valid: false, error: "API key is invalid." };
    return { valid: false, error: `Anthropic API error: ${res.status}` };
  } catch (err) {
    return {
      valid: false,
      error:
        err instanceof Error ? err.message : "Could not reach Anthropic API.",
    };
  }
}

// Claude subscription OAuth tokens from `claude setup-token` look like
// "sk-ant-oat01-…". They only work through the Claude Code CLI (not the plain
// Messages API), so validation is a format check; a bad token fails at run time.
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";

/**
 * Validates the shape of a Claude Code OAuth token (`claude setup-token`).
 * OAuth tokens are scoped to Claude Code and can't be probed against the
 * Anthropic API, so this is a format check only.
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
