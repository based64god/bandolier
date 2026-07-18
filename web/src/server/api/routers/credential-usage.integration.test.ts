import { beforeEach, describe, expect, it } from "vitest";

// The footer's credential-usage indicators end to end against a REAL Postgres:
// a deploy records usage (recordCredentialUsage), then the dashboard reads it
// back (account.recentCredentialUsage). This is the seam the unit tests mock
// away — recordCredentialUsage builds the subscription window update as raw
// `sql`, whose Date binding only fails against a live driver, so the mocked
// tests passed while every subscription deploy threw in production.
const { accountRouter } = await import("~/server/api/routers/account");
const { createCallerFactory } = await import("~/server/api/trpc");
const { recordCredentialUsage } =
  await import("~/server/agents/credential-usage");
const { db, resetDb, testCtx } = await import("~/test/integration/harness");
const { seedUser } = await import("~/test/integration/seed");

const createCaller = createCallerFactory(accountRouter);
const caller = (user: { id: string }) => createCaller(testCtx(user));

describe("credential-usage record → read (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("surfaces a metered deploy as a timestamp-only badge", async () => {
    const u = await seedUser();
    await recordCredentialUsage(db, u.id, "anthropic", "api_key");

    const rows = await caller(u).recentCredentialUsage();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("anthropic");
    expect(rows[0]!.authKind).toBe("api_key");
    // Metered keys carry no meter; the footer shows a "used …" timestamp instead.
    expect(rows[0]!.usage).toBeNull();
  });

  it("records a subscription deploy and increments its rolling window on the next", async () => {
    const u = await seedUser();
    // The upsert path: the second deploy conflicts on (user, provider) and must
    // run the window CASE-WHEN increment — the exact statement that threw before.
    await recordCredentialUsage(db, u.id, "anthropic", "subscription");
    await recordCredentialUsage(db, u.id, "anthropic", "subscription");

    const rows = await caller(u).recentCredentialUsage();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authKind).toBe("subscription");
    expect(rows[0]!.usage).not.toBeNull();
    expect(rows[0]!.usage!.runs).toBe(2);
    expect(rows[0]!.usage!.budget).toBeGreaterThan(0);
  });

  it("does not let a metered deploy spend a subscription's window budget", async () => {
    const u = await seedUser();
    await recordCredentialUsage(db, u.id, "anthropic", "subscription");
    // A subscription and an API key for the same provider share one row; a
    // metered deploy updates the auth kind but must leave the window untouched.
    await recordCredentialUsage(db, u.id, "anthropic", "api_key");

    const rows = await caller(u).recentCredentialUsage();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authKind).toBe("api_key");
    expect(rows[0]!.usage).toBeNull();
  });
});
