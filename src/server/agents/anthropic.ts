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

/** Loads a user's stored Anthropic API key, or null if none is configured. */
export async function getUserAnthropicKey(
  database: typeof db,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ apiKey: userAnthropicCredentials.apiKey })
    .from(userAnthropicCredentials)
    .where(eq(userAnthropicCredentials.userId, userId))
    .limit(1);
  return row?.apiKey ?? null;
}
