import { sql } from "drizzle-orm";
import { afterEach } from "vitest";

import { db } from "~/server/db";

// Shared scaffolding for the *.integration.test.ts suites. The db singleton here
// is the real one from ~/server/db — the worker's DATABASE_URL points it at the
// migrated throwaway Postgres, so callers exercise real SQL, constraints, and
// cascades. Import { db } from here (or from ~/server/db directly) — both are
// the same connection.
export { db };

// A tRPC session context in the exact shape createTRPCContext produces, minus
// the real better-auth round-trip: integration tests stub the *session* but use
// a real db and real procedures. Mirrors the fake used by the router unit tests.
export function fakeSession(user: {
  id: string;
  name?: string;
  email?: string;
}) {
  return {
    session: {
      id: `sess-${user.id}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    user: {
      id: user.id,
      name: user.name ?? "Test User",
      email: user.email ?? `${user.id}@test.local`,
    },
  };
}

// testCtx builds the tRPC context an integration caller runs with: the real
// test db and a stubbed session for `user`. Pass it to a per-router caller made
// with createCallerFactory(theRouter) — the concrete router keeps the caller
// fully typed. Returns `never` so it drops straight into any router's context
// slot without a per-call cast (the session shape is stubbed, not the real
// better-auth one). Mirrors the ctx the router unit tests build.
export function testCtx(user: {
  id: string;
  name?: string;
  email?: string;
}): never {
  return {
    db,
    headers: new Headers(),
    session: fakeSession(user),
  } as never;
}

// resetDb truncates every application table between tests so each starts clean.
// RESTART IDENTITY resets bigserial sequences (acp_frame.seq) so ordering
// assertions are deterministic; CASCADE handles the FK web. The migrations
// bookkeeping lives in the `drizzle` schema, so a public-only truncate never
// touches it. Tables are read from the catalog (not hardcoded) so a new table
// or a migration's stray helper table is swept automatically.
export async function resetDb(): Promise<void> {
  const rows = (await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  )) as unknown as Array<{ tablename: string }>;
  const tables = rows.map((r) => r.tablename);
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(", ");
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
}

// useCleanDb wires resetDb to run after every test in the calling suite. Call it
// once at the top of a describe block (or module).
export function useCleanDb(): void {
  afterEach(resetDb);
}
