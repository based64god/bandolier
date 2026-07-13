import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";

import { type db } from "~/server/db";
import { apiKey } from "~/server/db/schema";

// Tokens look like "bnd_<random>"; we store only the SHA-256 hash and show the
// plaintext exactly once at creation.
const TOKEN_PREFIX = "bnd_";
const DISPLAY_PREFIX_LEN = TOKEN_PREFIX.length + 6;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface CreatedApiKey {
  id: string;
  /** Full plaintext token — returned only here, never stored or shown again. */
  token: string;
  prefix: string;
}

export async function createApiKey(
  database: typeof db,
  userId: string,
  name: string,
  expiresAt: Date | null,
): Promise<CreatedApiKey> {
  const id = crypto.randomUUID();
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  const prefix = token.slice(0, DISPLAY_PREFIX_LEN);

  await database.insert(apiKey).values({
    id,
    userId,
    name,
    prefix,
    keyHash: hashToken(token),
    expiresAt,
  });

  return { id, token, prefix };
}

export async function listApiKeys(database: typeof db, userId: string) {
  return database
    .select({
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(eq(apiKey.userId, userId))
    .orderBy(desc(apiKey.createdAt));
}

export async function revokeApiKey(
  database: typeof db,
  userId: string,
  id: string,
): Promise<void> {
  await database
    .delete(apiKey)
    .where(and(eq(apiKey.id, id), eq(apiKey.userId, userId)));
}

/**
 * Resolves a bearer token to the owning user id, or null if the token is unknown
 * or expired. Touches lastUsedAt on success.
 */
export async function resolveApiKey(
  database: typeof db,
  token: string,
): Promise<{ userId: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const [row] = await database
    .select({
      id: apiKey.id,
      userId: apiKey.userId,
      expiresAt: apiKey.expiresAt,
    })
    .from(apiKey)
    .where(eq(apiKey.keyHash, hashToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  await database
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, row.id));

  return { userId: row.userId };
}
