import webpush from "web-push";
import { and, eq } from "drizzle-orm";

import { env } from "~/env";
import { db as defaultDb } from "~/server/db";
import { pushSubscription } from "~/server/db/schema";

/**
 * Web Push fan-out: delivers a notification payload to every browser/device a
 * user has subscribed, even when no Bandolier tab is open. The service worker's
 * `push` handler (public/sw.js) renders the payload as a system notification.
 *
 * Push is enabled only when a VAPID keypair is configured (see env.js). When it
 * isn't, every call here is a no-op so the dashboard's in-tab alerts remain the
 * only notification path — nothing breaks on a deployment without keys.
 */

let configured = false;

/** True when a VAPID keypair is set, so push can actually be sent. */
export function webPushEnabled(): boolean {
  return !!env.WEB_PUSH_VAPID_PUBLIC_KEY && !!env.WEB_PUSH_VAPID_PRIVATE_KEY;
}

/** The public VAPID key the browser needs to create a subscription, or null. */
export function vapidPublicKey(): string | null {
  return env.WEB_PUSH_VAPID_PUBLIC_KEY ?? null;
}

/** Lazily wire the VAPID details into the web-push library (once per process). */
function ensureConfigured(): boolean {
  if (!webPushEnabled()) return false;
  if (!configured) {
    webpush.setVapidDetails(
      env.WEB_PUSH_CONTACT,
      env.WEB_PUSH_VAPID_PUBLIC_KEY!,
      env.WEB_PUSH_VAPID_PRIVATE_KEY!,
    );
    configured = true;
  }
  return true;
}

/** The JSON payload the service worker's push handler expects. */
export interface PushPayload {
  title: string;
  body: string;
  /** Collapses repeat notifications for the same subject (e.g. one per job). */
  tag?: string;
  /** Relative URL focused/opened when the notification is clicked. */
  url?: string;
}

/**
 * Sends a payload to all of a user's subscriptions. Best-effort: a failure to
 * one device never throws to the caller (a harness callback / tRPC mutation
 * shouldn't fail because a stale subscription rejected). Subscriptions a push
 * service reports permanently gone (404/410) are pruned so they don't pile up.
 *
 * Returns the number of subscriptions successfully delivered to.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  db: typeof defaultDb = defaultDb,
): Promise<number> {
  if (!ensureConfigured()) return 0;

  const subs = await db
    .select()
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, userId));
  if (subs.length === 0) return 0;

  const body = JSON.stringify(payload);
  let delivered = 0;

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
        delivered++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        // 404/410 mean the subscription is permanently gone (unsubscribed or
        // expired) — drop it. Other errors are transient; leave the row.
        if (statusCode === 404 || statusCode === 410) {
          await db
            .delete(pushSubscription)
            .where(
              and(
                eq(pushSubscription.endpoint, sub.endpoint),
                eq(pushSubscription.userId, userId),
              ),
            );
        } else {
          console.warn("[bandolier:push] send failed", {
            statusCode,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
  );

  return delivered;
}
