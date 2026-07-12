import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveApiKey } from "~/server/agents/api-keys";
import { apiKeysRouter } from "~/server/api/routers/api-keys";
import { createCallerFactory } from "~/server/api/trpc";
import { apiKey } from "~/server/db/schema";
import { db, resetDb, testCtx } from "~/test/integration/harness";
import { seedApiKey, seedUser } from "~/test/integration/seed";

const createCaller = createCallerFactory(apiKeysRouter);
const caller = (user: { id: string }) => createCaller(testCtx(user));

// The flagship integration test: a pure-DB seam (no external I/O) that proves
// the whole harness — real Postgres, real constraints, real cross-user WHERE
// clauses — while covering the api-key lifecycle a fakeDb structurally cannot:
// the unique-hash constraint, the cross-user revoke boundary, expiry, and the
// user-cascade delete.
describe("api-keys lifecycle (real Postgres)", () => {
  beforeEach(resetDb);

  it("create() writes a real row and returns the plaintext exactly once", async () => {
    const u = await seedUser();

    const created = await caller(u).create({ name: "ci" });
    expect(created.token).toMatch(/^bnd_/);
    expect(created.prefix).toBe(created.token.slice(0, "bnd_".length + 6));

    // The row exists with a hash, never the plaintext.
    const [row] = await db
      .select()
      .from(apiKey)
      .where(eq(apiKey.id, created.id));
    expect(row).toBeTruthy();
    expect(row!.name).toBe("ci");
    expect(row!.keyHash).not.toContain(created.token);
    expect(row!.keyHash).toHaveLength(64); // sha-256 hex
  });

  it("list() is scoped to the caller — user B never sees user A's keys", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await seedApiKey(a.id, { name: "a-key" });
    await seedApiKey(b.id, { name: "b-key" });

    const asA = await caller(a).list();
    const asB = await caller(b).list();

    expect(asA.map((k) => k.name)).toEqual(["a-key"]);
    expect(asB.map((k) => k.name)).toEqual(["b-key"]);
  });

  it("revoke() enforces the ownership boundary in the real WHERE clause", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const aKey = await seedApiKey(a.id, { name: "a-key" });

    // User B tries to revoke A's key by id: the and(eq(id), eq(userId)) guard
    // means the DELETE matches nothing — A's row SURVIVES. A fakeDb cannot
    // exercise this cross-user boundary.
    await caller(b).revoke({ id: aKey.id });
    const stillThere = await db
      .select()
      .from(apiKey)
      .where(eq(apiKey.id, aKey.id));
    expect(stillThere).toHaveLength(1);

    // The owner can revoke it.
    await caller(a).revoke({ id: aKey.id });
    const gone = await db.select().from(apiKey).where(eq(apiKey.id, aKey.id));
    expect(gone).toHaveLength(0);
  });

  it("resolveApiKey() resolves valid tokens, rejects expired/unknown, and touches lastUsedAt", async () => {
    const u = await seedUser();
    const valid = await seedApiKey(u.id, { name: "valid" });
    const expired = await seedApiKey(u.id, {
      name: "expired",
      expiresAt: new Date(Date.now() - 60_000),
    });

    // Valid → owning user id, and lastUsedAt gets stamped.
    const resolved = await resolveApiKey(db, valid.token);
    expect(resolved).toEqual({ userId: u.id });
    const [row] = await db
      .select()
      .from(apiKey)
      .where(eq(apiKey.id, valid.id));
    expect(row!.lastUsedAt).not.toBeNull();

    // Expired → null (the real expiry branch, against a real past timestamp).
    expect(await resolveApiKey(db, expired.token)).toBeNull();

    // Unknown / malformed → null.
    expect(await resolveApiKey(db, "bnd_nope")).toBeNull();
    expect(await resolveApiKey(db, "not-a-bandolier-token")).toBeNull();
  });

  it("rejects a duplicate key hash via the unique constraint", async () => {
    const u = await seedUser();
    const created = await seedApiKey(u.id);
    // Re-inserting the same hash must violate api_key_key_hash_unique.
    const [orig] = await db
      .select()
      .from(apiKey)
      .where(eq(apiKey.userId, u.id));
    await expect(
      db.insert(apiKey).values({
        id: "dup",
        userId: u.id,
        name: "dup",
        prefix: orig!.prefix,
        keyHash: orig!.keyHash,
      }),
    ).rejects.toThrow();
    expect(created).toBeTruthy();
  });

  it("cascades api_key rows when the owning user is deleted", async () => {
    const { user } = await import("~/server/db/schema");
    const u = await seedUser();
    await seedApiKey(u.id, { name: "k1" });
    await seedApiKey(u.id, { name: "k2" });

    await db.delete(user).where(eq(user.id, u.id));

    const remaining = await db
      .select()
      .from(apiKey)
      .where(eq(apiKey.userId, u.id));
    expect(remaining).toHaveLength(0);
  });

  it("keeps the and(id,userId) delete scoped even with same-id collisions across users", async () => {
    // Two users, keys with distinct ids; revoking by A must not touch B even if
    // B guesses A's id (covered above) — here we assert the positive: A's own
    // revoke leaves B's key intact.
    const a = await seedUser();
    const b = await seedUser();
    const aKey = await seedApiKey(a.id);
    await seedApiKey(b.id);

    await caller(a).revoke({ id: aKey.id });

    const bKeys = await db
      .select()
      .from(apiKey)
      .where(and(eq(apiKey.userId, b.id)));
    expect(bKeys).toHaveLength(1);
  });
});
