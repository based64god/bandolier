import { eq } from "drizzle-orm";

import {
  baseFieldOf,
  gollmProviderInfo,
  gollmProviderName,
  keyFieldOf,
  providerFields,
} from "~/server/agents/gollm-catalog";
import { probeApiKey, type Validation } from "~/server/agents/validation";
import { type db } from "~/server/db";
import {
  repoCustomProviderCredentials,
  userCustomProviderCredentials,
} from "~/server/db/schema";

// Credentials for the gollm-proxied providers (user- and repo-scoped): DB
// access plus the OpenAI-compatible model listing the picker uses. The catalog
// (~/server/agents/gollm-catalog) is the single source of provider metadata.

/** A stored custom-provider credential, with its JSON fields parsed. */
export interface CustomProviderCredential {
  /** gollm provider id ("groq", "openrouter", …). */
  provider: string;
  apiKey: string | null;
  apiBase: string | null;
  extraEnv: Record<string, string> | null;
  /** User-supplied model ids for the picker (non-listable providers). */
  models: string[] | null;
}

/** The stored-row shape both scoped tables share (JSON fields as text). */
interface CustomProviderRow {
  provider: string;
  apiKey: string | null;
  apiBase: string | null;
  extraEnv: string | null;
  models: string | null;
}

/** Parses a stored row into a credential, keeping catalog-known providers only. */
function rowToCredential(row: CustomProviderRow): CustomProviderCredential {
  return {
    provider: row.provider,
    apiKey: row.apiKey,
    apiBase: row.apiBase,
    extraEnv: parseJSONObject(row.extraEnv),
    models: parseModels(row.models),
  };
}

function parseJSONObject(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function parseModels(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const models = parsed.filter((m): m is string => typeof m === "string");
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/** All of a user's custom-provider credentials, catalog-known ones only. */
export async function getUserCustomProviders(
  database: typeof db,
  userId: string,
): Promise<CustomProviderCredential[]> {
  const rows = await database
    .select()
    .from(userCustomProviderCredentials)
    .where(eq(userCustomProviderCredentials.userId, userId));
  return rows.filter((r) => gollmProviderInfo(r.provider)).map(rowToCredential);
}

/** All of a repo's shared custom-provider credentials, catalog-known ones only. */
export async function getRepoCustomProviders(
  database: typeof db,
  repoFullName: string,
): Promise<CustomProviderCredential[]> {
  const rows = await database
    .select()
    .from(repoCustomProviderCredentials)
    .where(eq(repoCustomProviderCredentials.repoFullName, repoFullName));
  return rows.filter((r) => gollmProviderInfo(r.provider)).map(rowToCredential);
}

/**
 * Merges two custom-provider sets by provider id: entries from `primary` win,
 * `fallback` fills the gaps. Mirrors how a repo set's Gemini key falls back to
 * the user's (`repoGemini ?? userGemini`), extended to a keyed list.
 */
export function mergeCustomProviders(
  primary: CustomProviderCredential[],
  fallback: CustomProviderCredential[],
): CustomProviderCredential[] {
  const byId = new Map(fallback.map((c) => [c.provider, c]));
  for (const c of primary) byId.set(c.provider, c);
  return [...byId.values()];
}

// ── Model listing ────────────────────────────────────────────────────────────

/**
 * Ids of models an OpenAI-compatible `GET /models` reports that aren't usable
 * as an agent's chat/tool model — embeddings, rerankers, moderation/guard
 * classifiers, and speech/image models. Matched as bounded tokens so a chat
 * model id doesn't trip on an incidental substring. Unlike the first-class
 * providers (which filter to chat/tool-capable models), a raw gollm `/models`
 * lists everything the backend serves, so the picker would otherwise offer
 * models a run can never use.
 */
const NON_CHAT_MODEL =
  /(?:^|[-_/.])(?:embed(?:ding)?s?|rerank(?:er|ing)?|moderations?|guard|whisper|tts|stt|speech|transcrib\w*|dall-?e|stable-?diffusion|sdxl|flux|clip|bge|gte|voyage|colbert)(?:[-_/.]|$)/i;

/** Whether a listed model id looks like a usable chat/tool model. */
function isLikelyChatModel(id: string): boolean {
  return !NON_CHAT_MODEL.test(id);
}

/**
 * Lists a custom provider's models for the picker: the OpenAI-compatible
 * GET {base}/models when the catalog says the provider serves one, merged
 * with (and falling back to) the user-supplied model list. Throws only when
 * the provider ends up with no models at all.
 */
export async function listCustomProviderModels(
  cred: CustomProviderCredential,
): Promise<{ id: string; label: string }[]> {
  const info = gollmProviderInfo(cred.provider);
  const stored = (cred.models ?? []).map((id) => ({ id, label: id }));

  const base = cred.apiBase ?? info?.defaultBase;
  if (!info?.listable || !base) {
    if (stored.length === 0) {
      throw new Error(
        `no models configured for ${cred.provider} — add model ids to the credential`,
      );
    }
    return stored;
  }

  try {
    const headers: Record<string, string> = {};
    if (cred.apiKey) headers.Authorization = `Bearer ${cred.apiKey}`;
    const res = await fetch(`${base.replace(/\/+$/, "")}/models`, { headers });
    if (!res.ok) throw new Error(`${info.label} API ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const all = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    // Drop non-chat models (embeddings, rerankers, …). If that leaves nothing —
    // an all-embeddings provider, or a naming scheme the filter misreads — keep
    // the raw list rather than blank the picker.
    const chat = all.filter(isLikelyChatModel);
    const listed = (chat.length > 0 ? chat : all).map((id) => ({
      id,
      label: id,
    }));
    if (listed.length === 0) return stored;
    // Stored ids the listing doesn't know stay available (aliases, previews).
    const seen = new Set(listed.map((m) => m.id));
    return [...listed, ...stored.filter((m) => !seen.has(m.id))];
  } catch (err) {
    if (stored.length > 0) return stored;
    throw err;
  }
}

export { gollmProviderName };

// ── Settings input handling ──────────────────────────────────────────────────

/**
 * The settings form's raw input for one custom provider: the provider id, a
 * map of the provider's declared field env vars to their entered values, and
 * the optional model list. The bespoke form shape lives in the catalog
 * (`providerFields`); this just carries whatever fields it declared.
 */
export interface CustomProviderInput {
  provider: string;
  /** Field env var → entered value (see `providerFields`). */
  fields: Record<string, string>;
  /** Model ids, comma- or newline-separated. */
  models?: string;
}

function parseModelsInput(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * Normalizes the form input into the stored row shape. The provider's key
 * field packs into apiKey, its endpoint field into apiBase, and every other
 * field into the extraEnv map — the same three columns gollmProviderEnv reads,
 * so storage and pod-injection are unchanged. Call only after validation.
 */
export function normalizeCustomProviderInput(input: CustomProviderInput): {
  provider: string;
  apiKey: string | null;
  apiBase: string | null;
  extraEnv: string | null;
  models: string | null;
} {
  const info = gollmProviderInfo(input.provider);
  const keyEnv = info ? keyFieldOf(info)?.env : undefined;
  const baseEnv = info ? baseFieldOf(info)?.env : undefined;

  let apiKey: string | null = null;
  let apiBase: string | null = null;
  const extra: Record<string, string> = {};
  for (const [env, raw] of Object.entries(input.fields)) {
    const value = raw?.trim();
    if (!value) continue;
    if (env === keyEnv) apiKey = value;
    else if (env === baseEnv) apiBase = value;
    else extra[env] = value;
  }

  const models = parseModelsInput(input.models ?? "");
  return {
    provider: input.provider,
    apiKey,
    apiBase,
    extraEnv: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
    models: models.length > 0 ? JSON.stringify(models) : null,
  };
}

/**
 * Validates a custom-provider credential against its declared fields: the
 * provider must be in the catalog, every required field must be present, a
 * non-listable provider needs at least one model id, and — where the provider
 * serves an OpenAI-compatible /models — the key is probed against it.
 */
export async function validateCustomProviderInput(
  input: CustomProviderInput,
): Promise<Validation> {
  const info = gollmProviderInfo(input.provider);
  if (!info) {
    return { valid: false, error: `Unknown provider "${input.provider}".` };
  }
  const value = (env: string) => (input.fields[env] ?? "").trim();

  for (const field of providerFields(info)) {
    if (!field.optional && !value(field.env)) {
      return { valid: false, error: `${info.label} requires ${field.label}.` };
    }
  }

  const models = parseModelsInput(input.models ?? "");
  if (!info.listable && models.length === 0) {
    return {
      valid: false,
      error: `${info.label} has no model-list API — add at least one model id.`,
    };
  }

  // Probe listable hosted endpoints so a bad key fails at save time. Local /
  // self-hosted endpoints (a required endpoint field) are often unreachable
  // from the server, so a probe failure there must not block saving.
  const keyField = keyFieldOf(info);
  const baseField = baseFieldOf(info);
  const key = keyField ? value(keyField.env) : "";
  const base = baseField ? value(baseField.env) : "";
  const selfHosted = !!baseField && !baseField.optional;
  const probeBase = base || info.defaultBase;
  if (info.listable && probeBase && key && !selfHosted) {
    return probeApiKey(
      `${probeBase.replace(/\/+$/, "")}/models`,
      { Authorization: `Bearer ${key}` },
      info.label,
    );
  }
  return { valid: true };
}

/**
 * Live-tests an already-stored custom-provider credential — the post-save "Test"
 * action, mirroring `testAws`/`testAnthropic` for the four first-class
 * providers. Probes the OpenAI-compatible `GET {base}/models` with the stored
 * key when the provider serves one from a reachable hosted endpoint. Local /
 * self-hosted (endpoint required) and non-listable providers can't be reached
 * from the server, so those report the stored credential as present without a
 * live probe.
 */
export async function testCustomProviderCredential(
  cred: CustomProviderCredential,
): Promise<Validation> {
  const info = gollmProviderInfo(cred.provider);
  if (!info) {
    return { valid: false, error: `Unknown provider "${cred.provider}".` };
  }
  const base = cred.apiBase ?? info.defaultBase;
  const key = cred.apiKey ?? "";
  const baseField = baseFieldOf(info);
  const selfHosted = !!baseField && !baseField.optional;
  if (info.listable && base && key && !selfHosted) {
    return probeApiKey(
      `${base.replace(/\/+$/, "")}/models`,
      { Authorization: `Bearer ${key}` },
      info.label,
    );
  }
  return { valid: true };
}
