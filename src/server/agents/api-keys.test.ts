import nodeCrypto from "crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import { apiKey } from "~/server/db/schema";
import {
  createApiKey,
  resolveApiKey,
  revokeApiKey,
} from "~/server/agents/api-keys";

// API-key lifecycle over faked drizzle chains: creation must store only the
// SHA-256 hash (plaintext shown once), resolution must check prefix + hash +
// expiry before touching lastUsedAt, and revocation must stay scoped to the
// calling user. `listApiKeys` is a branchless column projection — not tested.

const sha256 = (s: string) =>
  nodeCrypto.createHash("sha256").update(s).digest("hex");

function makeInsertDb() {
  const values = vi
    .fn<(v: Record<string, unknown>) => Promise<void>>()
    .mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return { database: { insert } as unknown as typeof Database, values };
}

/** select().from().where().limit() resolves `rows`; update chain is recorded. */
function makeResolveDb(rows: Record<string, unknown>[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn((_values: Record<string, unknown>) => ({
    where: updateWhere,
  }));
  const update = vi.fn(() => ({ set }));
  return {
    database: { select, update } as unknown as typeof Database,
    select,
    selectWhere,
    update,
    set,
    updateWhere,
  };
}

describe("createApiKey", () => {
  it("returns a bnd_ token and stores only its hash — never the plaintext", async () => {
    const { database, values } = makeInsertDb();
    const expiresAt = new Date("2027-01-01T00:00:00Z");
    const created = await createApiKey(database, "u1", "ci key", expiresAt);

    // bnd_ + 24 random bytes as base64url (32 chars).
    expect(created.token).toMatch(/^bnd_[A-Za-z0-9_-]{32}$/);
    expect(created.prefix).toBe(created.token.slice(0, 10));

    expect(values).toHaveBeenCalledTimes(1);
    const stored = values.mock.calls[0]![0];
    expect(stored).toEqual({
      id: created.id,
      userId: "u1",
      name: "ci key",
      prefix: created.prefix,
      keyHash: sha256(created.token),
      expiresAt,
    });
    // The plaintext token must not appear anywhere in the stored row.
    expect(Object.values(stored)).not.toContain(created.token);
  });

  it("passes a null expiresAt through (non-expiring key)", async () => {
    const { database, values } = makeInsertDb();
    await createApiKey(database, "u1", "forever", null);
    expect(values.mock.calls[0]![0]).toMatchObject({ expiresAt: null });
  });

  it("generates a distinct token per call", async () => {
    const { database } = makeInsertDb();
    const first = await createApiKey(database, "u1", "a", null);
    const second = await createApiKey(database, "u1", "b", null);
    expect(second.token).not.toBe(first.token);
  });
});

describe("resolveApiKey", () => {
  it("rejects tokens without the bnd_ prefix before ever querying", async () => {
    const { database, select } = makeResolveDb([]);
    expect(await resolveApiKey(database, "sk_wrongprefix")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("returns null for an unknown token, looked up by hash — not plaintext", async () => {
    const { database, selectWhere } = makeResolveDb([]);
    const token = "bnd_unknowntoken";
    expect(await resolveApiKey(database, token)).toBeNull();
    expect(selectWhere).toHaveBeenCalledWith(eq(apiKey.keyHash, sha256(token)));
  });

  it("returns null for an expired key and does not touch lastUsedAt", async () => {
    const { database, update } = makeResolveDb([
      { id: "k1", userId: "u1", expiresAt: new Date(Date.now() - 1000) },
    ]);
    expect(await resolveApiKey(database, "bnd_expired")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves a live key to its user and touches lastUsedAt", async () => {
    const { database, set, updateWhere } = makeResolveDb([
      { id: "k1", userId: "u1", expiresAt: null },
    ]);
    expect(await resolveApiKey(database, "bnd_livetoken")).toEqual({
      userId: "u1",
    });
    const touched = set.mock.calls[0]![0];
    expect(touched.lastUsedAt).toBeInstanceOf(Date);
    expect(updateWhere).toHaveBeenCalledWith(eq(apiKey.id, "k1"));
  });

  it("accepts a key whose expiry is still in the future", async () => {
    const { database } = makeResolveDb([
      { id: "k2", userId: "u2", expiresAt: new Date(Date.now() + 3600_000) },
    ]);
    expect(await resolveApiKey(database, "bnd_futuretoken")).toEqual({
      userId: "u2",
    });
  });
});

describe("revokeApiKey", () => {
  it("deletes only when BOTH key id and owner match — no cross-user revocation", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn(() => ({ where }));
    const database = { delete: del } as unknown as typeof Database;

    await revokeApiKey(database, "u1", "k1");

    // Built with the real operators so dropping the userId clause fails here.
    expect(where).toHaveBeenCalledWith(
      and(eq(apiKey.id, "k1"), eq(apiKey.userId, "u1")),
    );
  });
});
