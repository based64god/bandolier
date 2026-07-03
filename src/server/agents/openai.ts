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

/**
 * Validates the contents of `codex login`'s ~/.codex/auth.json for
 * ChatGPT-subscription auth. The tokens are OAuth session tokens that can't be
 * probed against the OpenAI API, so this checks the file's shape only.
 */
export function validateCodexAuthJson(raw: string): OpenaiValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      error:
        "Not valid JSON — paste the full contents of ~/.codex/auth.json after running `codex login`.",
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, error: "Expected a JSON object." };
  }
  const tokens = (parsed as { tokens?: unknown }).tokens;
  const hasTokens =
    typeof tokens === "object" &&
    tokens !== null &&
    (typeof (tokens as { access_token?: unknown }).access_token === "string" ||
      typeof (tokens as { refresh_token?: unknown }).refresh_token ===
        "string");
  if (!hasTokens) {
    const apiKey = (parsed as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY;
    if (typeof apiKey === "string" && apiKey.length > 0) {
      return {
        valid: false,
        error:
          "This auth.json holds an API key, not ChatGPT tokens — paste the key into the API key field instead.",
      };
    }
    return {
      valid: false,
      error:
        "No ChatGPT session tokens found — run `codex login` (browser sign-in) and paste the resulting ~/.codex/auth.json.",
    };
  }
  return { valid: true };
}

/** A user's OpenAI credentials: exactly one of the fields is set (or neither). */
export interface OpenaiCredentials {
  apiKey: string | null;
  /** Contents of `codex login`'s ~/.codex/auth.json (ChatGPT subscription). */
  codexAuthJson: string | null;
}

/** Loads a user's stored OpenAI credentials (API key or Codex auth.json). */
export async function getUserOpenaiCredentials(
  database: typeof db,
  userId: string,
): Promise<OpenaiCredentials> {
  const [row] = await database
    .select({
      apiKey: userOpenaiCredentials.apiKey,
      codexAuthJson: userOpenaiCredentials.codexAuthJson,
    })
    .from(userOpenaiCredentials)
    .where(eq(userOpenaiCredentials.userId, userId))
    .limit(1);
  return {
    apiKey: row?.apiKey ?? null,
    codexAuthJson: row?.codexAuthJson ?? null,
  };
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

/**
 * Whether an OpenAI model id is a chat model an agent can drive: it's in the GPT
 * or o-series chat families and isn't an embeddings/audio/image/moderation/
 * instruct variant.
 */
export function isChatModel(id: string): boolean {
  return CHAT_MODEL_RE.test(id) && !NON_CHAT_RE.test(id);
}

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
    .filter((m) => isChatModel(m.id))
    .map((m) => ({ id: m.id, label: m.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
