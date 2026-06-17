import { eq } from "drizzle-orm";

import { type db } from "~/server/db";
import { userOpenaiCredentials } from "~/server/db/schema";

export interface OpenaiValidation {
  valid: boolean;
  error?: string;
}

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/**
 * Validates an OpenAI API key with a cheap GET /v1/models call. A 401 means the
 * key is bad; 200 means it works.
 */
export async function validateOpenaiKey(
  apiKey: string,
): Promise<OpenaiValidation> {
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401)
      return { valid: false, error: "API key is invalid." };
    return { valid: false, error: `OpenAI API error: ${res.status}` };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Could not reach OpenAI API.",
    };
  }
}

/** Loads a user's stored OpenAI API key, or null if none is configured. */
export async function getUserOpenaiKey(
  database: typeof db,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ apiKey: userOpenaiCredentials.apiKey })
    .from(userOpenaiCredentials)
    .where(eq(userOpenaiCredentials.userId, userId))
    .limit(1);
  return row?.apiKey ?? null;
}

interface OpenaiModel {
  id: string;
}

// The /v1/models list mixes chat models with embeddings, audio, image, and
// moderation endpoints, none of which an agent can drive. Keep the GPT and
// o-series chat families and drop the rest so the picker only offers usable ids.
const CHAT_MODEL_RE = /^(gpt-|chatgpt-|o[0-9])/i;
const NON_CHAT_RE =
  /(embedding|whisper|tts|audio|realtime|transcribe|image|dall-e|moderation|search|instruct)/i;

/** Lists the chat-capable models available to an OpenAI API key. */
export async function listOpenaiModels(
  apiKey: string,
): Promise<{ id: string; label: string }[]> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${res.statusText}`);
  }
  const body = (await res.json()) as { data: OpenaiModel[] };
  return body.data
    .filter((m) => CHAT_MODEL_RE.test(m.id) && !NON_CHAT_RE.test(m.id))
    .map((m) => ({ id: m.id, label: m.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
