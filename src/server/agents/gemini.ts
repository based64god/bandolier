import { createSign } from "node:crypto";

import { eq } from "drizzle-orm";

import { type db } from "~/server/db";
import { userGeminiCredentials } from "~/server/db/schema";

export interface GeminiValidation {
  valid: boolean;
  error?: string;
}

/**
 * A Google service-account key JSON (the file downloaded from the Cloud
 * console). Only the fields the auth flow needs are typed.
 */
interface GoogleServiceAccount {
  type?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
// cloud-platform scope covers both Vertex AI (aiplatform) and the Generative
// Language API — the surfaces agy can use against a project.
const TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GEMINI_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

interface ParsedCredentials {
  creds?: GoogleServiceAccount;
  error?: string;
}

/**
 * Parses and structurally validates a Google Cloud project credentials JSON (a
 * service-account key). Returns a friendly error when it isn't JSON, isn't a
 * service-account key, or is missing the fields needed to authenticate. Cheap
 * and offline — the live check is a separate token mint.
 */
export function parseGoogleCredentials(raw: string): ParsedCredentials {
  let obj: GoogleServiceAccount;
  try {
    obj = JSON.parse(raw) as GoogleServiceAccount;
  } catch {
    return {
      error:
        "Not valid JSON — paste the full service-account key file (it starts with '{').",
    };
  }
  if (typeof obj !== "object" || obj === null) {
    return { error: "Credentials must be a JSON object." };
  }
  if (obj.type !== "service_account") {
    return {
      error:
        'Expected a service-account key (`"type": "service_account"`). Other credential types are not supported.',
    };
  }
  const missing = (
    ["project_id", "client_email", "private_key"] as const
  ).filter((k) => !obj[k]);
  if (missing.length > 0) {
    return { error: `Credentials are missing: ${missing.join(", ")}.` };
  }
  return { creds: obj };
}

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Mints a short-lived OAuth access token from a service-account key by signing a
 * JWT (RS256) and exchanging it at the account's token endpoint. Throws on any
 * failure (malformed key, revoked account, network error).
 */
export async function mintGoogleAccessToken(
  creds: GoogleServiceAccount,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = creds.token_uri ?? DEFAULT_TOKEN_URI;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: TOKEN_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  // private_key arrives as PEM with real newlines once the JSON is parsed.
  const signature = signer.sign(creds.private_key!, "base64url");
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Token exchange failed (${res.status}). ${detail.slice(0, 200)}`.trim(),
    );
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Token endpoint returned no access_token.");
  }
  return body.access_token;
}

/**
 * Validates a Google project credentials JSON: structural checks first, then a
 * live token mint to confirm the key actually works. A signing/exchange failure
 * means the key is malformed, revoked, or the account lacks token access.
 */
export async function validateGeminiCredentials(
  raw: string,
): Promise<GeminiValidation> {
  const { creds, error } = parseGoogleCredentials(raw);
  if (!creds) return { valid: false, error };
  try {
    await mintGoogleAccessToken(creds);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error:
        err instanceof Error
          ? err.message
          : "Could not verify the credentials.",
    };
  }
}

/** Loads a user's stored Gemini project credentials JSON, or null if none. */
export async function getUserGeminiKey(
  database: typeof db,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ apiKey: userGeminiCredentials.apiKey })
    .from(userGeminiCredentials)
    .where(eq(userGeminiCredentials.userId, userId))
    .limit(1);
  return row?.apiKey ?? null;
}

/**
 * Non-secret summary of a stored credentials JSON, for display in settings: the
 * project and the service-account email (never the private key). Returns nulls
 * if the stored value can't be parsed.
 */
export function summarizeGeminiCredentials(raw: string): {
  projectId: string | null;
  clientEmail: string | null;
} {
  const { creds } = parseGoogleCredentials(raw);
  return {
    projectId: creds?.project_id ?? null,
    clientEmail: creds?.client_email ?? null,
  };
}

interface GeminiModel {
  // Resource name, e.g. "models/gemini-2.5-pro".
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

/**
 * Lists the chat-capable Gemini models available to a project. Mints an OAuth
 * token from the credentials JSON and calls the models endpoint with a bearer
 * token (the project must have the Generative Language API enabled). Keeps the
 * `gemini-*` families that support `generateContent` (dropping embeddings, image,
 * and TTS models) and strips the `models/` prefix to the bare id the CLI expects.
 */
export async function listGeminiModels(
  credentialsJson: string,
): Promise<{ id: string; label: string }[]> {
  const { creds, error } = parseGoogleCredentials(credentialsJson);
  if (!creds) throw new Error(error ?? "Invalid Gemini credentials.");

  const token = await mintGoogleAccessToken(creds);
  const res = await fetch(`${GEMINI_MODELS_URL}?pageSize=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${res.statusText}`);
  }
  const body = (await res.json()) as { models?: GeminiModel[] };
  return (body.models ?? [])
    .filter(
      (m) =>
        m.name.startsWith("models/gemini") &&
        (m.supportedGenerationMethods ?? []).includes("generateContent"),
    )
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return { id, label: m.displayName ?? id };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
