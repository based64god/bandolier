import { describe, expect, it, vi } from "vitest";

import {
  getRecentCredentialUsage,
  recordCredentialUsage,
} from "~/server/agents/credential-usage";
import { type db } from "~/server/db";

// getRecentCredentialUsage only exercises select().from().where().orderBy(); a
// chain whose terminal orderBy() resolves to the given rows is enough (the eq/gte
// conditions are built with the real schema columns but discarded here).
function fakeReadDb(rows: { provider: string; lastUsedAt: Date }[]): typeof db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return chain as never;
}

describe("getRecentCredentialUsage", () => {
  it("returns the rows the query resolves to", async () => {
    const rows = [
      { provider: "anthropic", lastUsedAt: new Date("2026-01-01T00:00:00Z") },
      { provider: "gollm:groq", lastUsedAt: new Date("2025-12-31T00:00:00Z") },
    ];
    const result = await getRecentCredentialUsage(fakeReadDb(rows), "u1");
    expect(result).toEqual(rows);
  });
});

describe("recordCredentialUsage", () => {
  it("upserts the (user, provider) row keyed on both columns", async () => {
    const onConflictDoUpdate =
      vi.fn<(arg: { target: unknown[]; set: { lastUsedAt: Date } }) => unknown>();
    const values =
      vi.fn<
        (arg: { userId: string; provider: string; lastUsedAt: Date }) => {
          onConflictDoUpdate: typeof onConflictDoUpdate;
        }
      >(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const database = { insert } as never;

    await recordCredentialUsage(database, "u1", "gollm:groq");

    expect(insert).toHaveBeenCalledTimes(1);
    const inserted = values.mock.calls[0]![0];
    expect(inserted.userId).toBe("u1");
    expect(inserted.provider).toBe("gollm:groq");
    expect(inserted.lastUsedAt).toBeInstanceOf(Date);

    const conflict = onConflictDoUpdate.mock.calls[0]![0];
    expect(conflict.target).toHaveLength(2);
    // The same timestamp is written on both insert and update.
    expect(conflict.set.lastUsedAt).toBe(inserted.lastUsedAt);
  });
});
