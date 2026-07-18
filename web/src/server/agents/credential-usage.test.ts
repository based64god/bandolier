import { describe, expect, it, vi } from "vitest";

import {
  getRecentCredentialUsage,
  recordCredentialUsage,
  subscriptionUsage,
  SUBSCRIPTION_RUN_BUDGET,
  SUBSCRIPTION_WINDOW_MS,
  type CredentialUsageRow,
} from "~/server/agents/credential-usage";
import { type db } from "~/server/db";

// getRecentCredentialUsage only exercises select().from().where().orderBy(); a
// chain whose terminal orderBy() resolves to the given rows is enough (the eq/gte
// conditions are built with the real schema columns but discarded here).
function fakeReadDb(rows: CredentialUsageRow[]): typeof db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return chain as never;
}

const row = (over: Partial<CredentialUsageRow> = {}): CredentialUsageRow => ({
  provider: "anthropic",
  lastUsedAt: new Date("2026-01-01T00:00:00Z"),
  authKind: "subscription",
  windowStartedAt: new Date("2026-01-01T00:00:00Z"),
  windowRuns: 3,
  ...over,
});

describe("getRecentCredentialUsage", () => {
  it("returns the rows the query resolves to", async () => {
    const rows = [row({ provider: "anthropic" }), row({ provider: "gollm:groq" })];
    const result = await getRecentCredentialUsage(fakeReadDb(rows), "u1");
    expect(result).toEqual(rows);
  });
});

describe("recordCredentialUsage", () => {
  it("upserts the (user, provider) row with the auth kind and a fresh window", async () => {
    const onConflictDoUpdate = vi.fn<(arg: { target: unknown[] }) => unknown>();
    const values =
      vi.fn<
        (arg: {
          userId: string;
          provider: string;
          authKind: string;
          lastUsedAt: Date;
          windowStartedAt: Date;
          windowRuns: number;
        }) => { onConflictDoUpdate: typeof onConflictDoUpdate }
      >(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const database = { insert } as never;

    await recordCredentialUsage(database, "u1", "anthropic", "subscription");

    expect(insert).toHaveBeenCalledTimes(1);
    const inserted = values.mock.calls[0]![0];
    expect(inserted.userId).toBe("u1");
    expect(inserted.provider).toBe("anthropic");
    expect(inserted.authKind).toBe("subscription");
    expect(inserted.lastUsedAt).toBeInstanceOf(Date);
    // A new row opens its window now, counting this run as the first.
    expect(inserted.windowStartedAt).toBe(inserted.lastUsedAt);
    expect(inserted.windowRuns).toBe(1);

    const conflict = onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.target).toHaveLength(2);
  });
});

describe("subscriptionUsage", () => {
  const start = new Date("2026-01-01T00:00:00Z");

  it("reports the stored run count and the window's reset time within the window", () => {
    const now = start.getTime() + SUBSCRIPTION_WINDOW_MS / 2;
    const usage = subscriptionUsage(
      { windowStartedAt: start, windowRuns: 7 },
      now,
    );
    expect(usage.runs).toBe(7);
    expect(usage.budget).toBe(SUBSCRIPTION_RUN_BUDGET);
    expect(usage.resetsAt.getTime()).toBe(
      start.getTime() + SUBSCRIPTION_WINDOW_MS,
    );
  });

  it("reads an elapsed window as empty, so a quiet subscription shows no pressure", () => {
    const now = start.getTime() + SUBSCRIPTION_WINDOW_MS + 60_000;
    const usage = subscriptionUsage(
      { windowStartedAt: start, windowRuns: 20 },
      now,
    );
    expect(usage.runs).toBe(0);
  });
});
