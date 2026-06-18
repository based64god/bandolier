import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { pushSubscription } from "~/server/db/schema";
import { vapidPublicKey, webPushEnabled } from "~/server/agents/web-push";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

/**
 * Web Push subscription management. The browser creates a PushSubscription with
 * the server's public VAPID key, then registers it here so the server can push
 * agent events to it in the background (see ~/server/agents/web-push).
 */
export const pushRouter = createTRPCRouter({
  // The public VAPID key the client needs to create a subscription. `enabled`
  // is false when no keypair is configured, so the UI can fall back to in-tab
  // alerts instead of attempting (and failing) to subscribe.
  config: publicProcedure.query(() => ({
    enabled: webPushEnabled(),
    publicKey: vapidPublicKey(),
  })),

  // Register (or refresh) a browser's push subscription for the acting user.
  // Keyed by endpoint, so re-subscribing the same browser updates its keys
  // rather than duplicating — and re-homes it to the current user if the device
  // is now signed in as someone else.
  subscribe: protectedProcedure
    .input(
      z.object({
        endpoint: z.string().url(),
        p256dh: z.string().min(1),
        auth: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(pushSubscription)
        .values({
          endpoint: input.endpoint,
          userId: ctx.session.user.id,
          p256dh: input.p256dh,
          auth: input.auth,
        })
        .onConflictDoUpdate({
          target: pushSubscription.endpoint,
          set: {
            userId: ctx.session.user.id,
            p256dh: input.p256dh,
            auth: input.auth,
            updatedAt: new Date(),
          },
        });
      return { success: true };
    }),

  // Remove a subscription (e.g. the user turned notifications off). Scoped to
  // the acting user so one user can't delete another's subscription.
  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(pushSubscription)
        .where(
          and(
            eq(pushSubscription.endpoint, input.endpoint),
            eq(pushSubscription.userId, ctx.session.user.id),
          ),
        );
      return { success: true };
    }),
});
