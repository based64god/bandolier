import "server-only";

import { eq } from "drizzle-orm";
import webpush, { WebPushError } from "web-push";

import { env } from "~/env";
import { db } from "~/server/db";
import { pushSubscription } from "~/server/db/schema";

/**
 * The payload delivered to the service worker's `push` handler. Kept small and
 * flat — push services cap the encrypted payload (~4KB) and the worker only
 * needs enough to render a notification and route a click.
 */
export type PushPayload = {
  title: string;
  body: string;
  // Collapses duplicate alerts for the same event (the foreground in-tab
  // notification uses the same tag, so the two never stack).
  tag: string;
  // Where a click should take the user; the worker focuses/opens this path.
  url?: string;
};

/** The serialized browser subscription (PushSubscription.toJSON()). */
export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Upserts a browser's subscription for a user. Endpoint is the key, so
 * re-subscribing the same browser refreshes it and a subscription that moved to
 * this user (a shared device) is reassigned.
 */
export async function savePushSubscription(
  userId: string,
  sub: PushSubscriptionInput,
) {
  await db
    .insert(pushSubscription)
    .values({
      endpoint: sub.endpoint,
      userId,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
}

/** Removes a subscription (user turned notifications off, or it rotated away). */
export async function deletePushSubscription(endpoint: string) {
  await db
    .delete(pushSubscription)
    .where(eq(pushSubscription.endpoint, endpoint));
}

// VAPID needs the full trio to sign anything. Absent config = push disabled, so
// the app runs (with foreground-only alerts) without keys being provisioned.
function vapidConfigured(): boolean {
  return Boolean(
    env.VAPID_SUBJECT &&
    env.VAPID_PRIVATE_KEY &&
    env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  );
}

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return;
  webpush.setVapidDetails(
    env.VAPID_SUBJECT!,
    env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    env.VAPID_PRIVATE_KEY!,
  );
  vapidReady = true;
}

/**
 * Sends a push notification to every browser the user has subscribed. No-op
 * when push isn't configured or the user has no subscriptions. A push service
 * that reports the endpoint is gone (404/410) has its row pruned, so dead
 * subscriptions don't accumulate. Failures never throw — a notification is
 * best-effort and must not break the caller (the harness ingest callback).
 */
export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!vapidConfigured()) return;
  ensureVapid();

  const subs = await db
    .select()
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, userId));
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
      } catch (err) {
        if (
          err instanceof WebPushError &&
          (err.statusCode === 404 || err.statusCode === 410)
        ) {
          await db
            .delete(pushSubscription)
            .where(eq(pushSubscription.endpoint, sub.endpoint));
          return;
        }
        console.error("[bandolier:push] send failed", {
          endpoint: sub.endpoint,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
