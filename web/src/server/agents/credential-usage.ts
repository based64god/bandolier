import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { AuthKind } from "~/server/agents/resolve-credentials";
import { type db } from "~/server/db";
import { credentialUsage } from "~/server/db/schema";

/**
 * How far back a credential counts as "recently used" for the dashboard
 * footer's usage indicators.
 */
export const RECENT_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The rolling window a subscription's run allowance is counted over. Claude and
 * ChatGPT subscriptions meter usage against a rolling session window rather than
 * per-token billing, so the footer's "how close to maxed out" meter counts a
 * user's runs over this window and resets it once elapsed. Five hours matches
 * the well-known Claude session reset; it's an approximation, not a contract
 * with the provider.
 */
export const SUBSCRIPTION_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * Nominal number of agent runs a subscription's rolling window allows before it
 * maxes out — the denominator of the footer's usage meter. Subscriptions don't
 * publish a run cap (their real limits are token/message based and tier
 * dependent), so this is a deliberately round estimate: it makes the meter a
 * useful "how busy is this window" gauge without claiming provider-exact
 * numbers. Tune in one place if the estimate proves off.
 */
export const SUBSCRIPTION_RUN_BUDGET = 25;

/** A usage row as the footer needs it, before the router derives its meter. */
export interface CredentialUsageRow {
  provider: string;
  lastUsedAt: Date;
  authKind: string;
  windowStartedAt: Date;
  windowRuns: number;
}

/**
 * Marks the given provider's credential as used now by this user. `provider` is
 * the canonical run-provider name — one of the four first-class providers
 * ("bedrock"/"anthropic"/"openai"/"gemini") or a gollm-proxied one as
 * "gollm:<id>" — so every provider gollm supports gets tracked the same way.
 * `authKind` records whether the deploy routed through a metered API key or a
 * subscription, driving which indicator the footer shows.
 *
 * Upserts the (user, provider) row so each provider keeps a single record. Only
 * a subscription deploy touches the rolling window: a subscription and an API
 * key for the same provider share one (user, provider) row, so counting every
 * deploy would let metered API-key runs inflate the subscription's meter. A
 * subscription deploy that lands after the window has elapsed starts a fresh
 * window (count 1); one within it increments the count. Non-subscription
 * deploys leave the window bookkeeping untouched.
 */
export async function recordCredentialUsage(
  database: typeof db,
  userId: string,
  provider: string,
  authKind: AuthKind,
): Promise<void> {
  const now = new Date();
  const isSubscription = authKind === "subscription";
  // Compare and assign the window timestamps as ISO strings cast to `timestamp`,
  // matching how Drizzle serializes the Date-valued columns in the insert below.
  // A raw Date embedded in a `sql` template is handed to the driver unmapped,
  // which postgres-js rejects ("Received an instance of Date"), so every
  // subscription upsert would throw — silently, since the caller treats usage
  // telemetry as best-effort. The cast keeps the window update off the
  // Date-binding path while storing the exact same UTC wall-clock.
  const nowIso = now.toISOString();
  const windowFloorIso = new Date(
    now.getTime() - SUBSCRIPTION_WINDOW_MS,
  ).toISOString();
  // Reset the window in the same statement the count increments in, so
  // concurrent deploys can't race a read-then-write: the started-at and count
  // both branch on whether the stored window has elapsed.
  const windowExpired = sql`${credentialUsage.windowStartedAt} < ${windowFloorIso}::timestamp`;
  const windowUpdate = isSubscription
    ? {
        windowStartedAt: sql`CASE WHEN ${windowExpired} THEN ${nowIso}::timestamp ELSE ${credentialUsage.windowStartedAt} END`,
        windowRuns: sql`CASE WHEN ${windowExpired} THEN 1 ELSE ${credentialUsage.windowRuns} + 1 END`,
      }
    : {};
  await database
    .insert(credentialUsage)
    .values({
      userId,
      provider,
      authKind,
      lastUsedAt: now,
      windowStartedAt: now,
      windowRuns: isSubscription ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [credentialUsage.userId, credentialUsage.provider],
      set: {
        authKind,
        lastUsedAt: now,
        ...windowUpdate,
      },
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
): Promise<CredentialUsageRow[]> {
  const since = new Date(Date.now() - windowMs);
  return database
    .select({
      provider: credentialUsage.provider,
      lastUsedAt: credentialUsage.lastUsedAt,
      authKind: credentialUsage.authKind,
      windowStartedAt: credentialUsage.windowStartedAt,
      windowRuns: credentialUsage.windowRuns,
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

/**
 * A subscription's meter reading for the footer: how many runs it has spent of
 * its rolling-window budget, and when the window resets. Derived from a stored
 * row's window bookkeeping; a window that has already elapsed reads as empty
 * (the next run would start fresh), so a quiet subscription never shows stale
 * pressure.
 */
export interface SubscriptionUsage {
  runs: number;
  budget: number;
  resetsAt: Date;
}

export function subscriptionUsage(
  row: Pick<CredentialUsageRow, "windowStartedAt" | "windowRuns">,
  now: number = Date.now(),
): SubscriptionUsage {
  const windowStart = row.windowStartedAt.getTime();
  const elapsed = now - windowStart >= SUBSCRIPTION_WINDOW_MS;
  return {
    runs: elapsed ? 0 : row.windowRuns,
    budget: SUBSCRIPTION_RUN_BUDGET,
    resetsAt: new Date(windowStart + SUBSCRIPTION_WINDOW_MS),
  };
}
