import { z } from "zod";

import { deletePushSubscription, savePushSubscription } from "~/server/push";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// The shape a browser's PushSubscription serializes to (subscription.toJSON()).
const subscriptionInput = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

export const pushRouter = createTRPCRouter({
  // Persists (or refreshes) the caller's browser subscription so the server can
  // deliver background notifications to it.
  subscribe: protectedProcedure
    .input(subscriptionInput)
    .mutation(async ({ ctx, input }) => {
      await savePushSubscription(ctx.session.user.id, input);
      return { ok: true };
    }),

  // Drops the caller's subscription when they turn notifications off.
  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: z.string() }))
    .mutation(async ({ input }) => {
      await deletePushSubscription(input.endpoint);
      return { ok: true };
    }),
});
