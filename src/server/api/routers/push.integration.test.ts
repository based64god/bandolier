import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { pushRouter } from "~/server/api/routers/push";
import { createCallerFactory } from "~/server/api/trpc";
import { pushSubscription } from "~/server/db/schema";
import { db, resetDb, testCtx } from "~/test/integration/harness";
import { seedPushSubscription, seedUser } from "~/test/integration/seed";

// The push router writes through the MODULE-SINGLETON db in ~/server/push (not
// ctx.db), so a passing test also proves that singleton points at the same test
// Postgres the harness truncates — otherwise these reads would see nothing. No
// external stub: subscribe/unsubscribe never call web-push (only sendPushToUser
// does), so the endpoint-keyed upsert, cross-user reassignment, and cascade all
// run as real SQL.
const createCaller = createCallerFactory(pushRouter);
const caller = (user: { id: string }) => createCaller(testCtx(user));

const ENDPOINT = "https://push.example.com/shared-device";

function subInput(endpoint: string) {
  return { endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } };
}

describe("push subscription lifecycle (real Postgres)", () => {
  beforeEach(resetDb);

  it("subscribe() upserts on the endpoint (re-subscribe refreshes, not duplicates)", async () => {
    const u = await seedUser();

    await caller(u).subscribe(subInput(ENDPOINT));
    await caller(u).subscribe({
      endpoint: ENDPOINT,
      keys: { p256dh: "rotated-p256dh", auth: "rotated-auth" },
    });

    const rows = await db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.endpoint, ENDPOINT));
    // One row (endpoint is the PK); the second subscribe refreshed its keys.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(u.id);
    expect(rows[0]!.p256dh).toBe("rotated-p256dh");
    expect(rows[0]!.auth).toBe("rotated-auth");
  });

  it("re-subscribing the same endpoint under a different user reassigns the row", async () => {
    const a = await seedUser();
    const b = await seedUser();

    await caller(a).subscribe(subInput(ENDPOINT));
    // Shared-device semantics: user B signs in on the same browser and enables
    // notifications — the endpoint's row moves to B rather than duplicating.
    await caller(b).subscribe(subInput(ENDPOINT));

    const rows = await db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.endpoint, ENDPOINT));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(b.id);
    // A now owns nothing.
    expect(
      await db
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.userId, a.id)),
    ).toHaveLength(0);
  });

  it("unsubscribe() deletes the row by endpoint", async () => {
    const u = await seedUser();
    await seedPushSubscription(u.id, { endpoint: ENDPOINT });
    // A second endpoint for the same user must survive the targeted delete.
    await seedPushSubscription(u.id, {
      endpoint: "https://push.example.com/other",
    });

    await caller(u).unsubscribe({ endpoint: ENDPOINT });

    const rows = await db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toBe("https://push.example.com/other");
  });

  it("deleting a user cascades their push_subscription rows", async () => {
    const u = await seedUser();
    await seedPushSubscription(u.id, { endpoint: ENDPOINT });
    await seedPushSubscription(u.id, {
      endpoint: "https://push.example.com/second",
    });

    const { user } = await import("~/server/db/schema");
    await db.delete(user).where(eq(user.id, u.id));

    expect(
      await db
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.userId, u.id)),
    ).toHaveLength(0);
  });
});
