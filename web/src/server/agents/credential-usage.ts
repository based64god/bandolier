import { and, desc, eq, gte } from "drizzle-orm";

import { type db } from "~/server/db";
import { credentialUsage } from "~/server/db/schema";

/**
 * How far back a credential counts as "recently used" for the dashboard
 * footer's usage indicators.
 */
export const RECENT_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Marks the given provider's credential as used now by this user. `provider` is
 * the canonical run-provider name — one of the four first-class providers
 * ("bedrock"/"anthropic"/"openai"/"gemini") or a gollm-proxied one as
 * "gollm:<id>" — so every provider gollm supports gets tracked the same way.
 * Upserts the (user, provider) row so each provider keeps a single last-used
 * timestamp.
 */
export async function recordCredentialUsage(
  database: typeof db,
  userId: string,
  provider: string,
): Promise<void> {
  const now = new Date();
  await database
    .insert(credentialUsage)
    .values({ userId, provider, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [credentialUsage.userId, credentialUsage.provider],
      set: { lastUsedAt: now },
    });
}

/**
 * The providers a user has run an agent on within `windowMs`, most-recent
 * first — the source for the footer's usage indicators.
 */
export async function getRecentCredentialUsage(
  database: typeof db,
  userId: string,
  windowMs: number = RECENT_USAGE_WINDOW_MS,
): Promise<{ provider: string; lastUsedAt: Date }[]> {
  const since = new Date(Date.now() - windowMs);
  return database
    .select({
      provider: credentialUsage.provider,
      lastUsedAt: credentialUsage.lastUsedAt,
    })
    .from(credentialUsage)
    .where(
      and(
        eq(credentialUsage.userId, userId),
        gte(credentialUsage.lastUsedAt, since),
      ),
    )
    .orderBy(desc(credentialUsage.lastUsedAt));
}
