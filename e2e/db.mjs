// Direct database access for the authenticated browser product-flow specs
// (e2e/*.authflow.mjs), used by the runner (authflow-run.mjs) to migrate + reset
// the throwaway Postgres and by specs to seed rows the UI reads. Uses raw SQL via
// the `postgres` driver so this stays a plain .mjs (no importing the TS schema).
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for authenticated flows");
  return postgres(url, { max: 1 });
}

// Bring the database up to the production schema (the same migrations the app
// and the integration globalSetup apply).
export async function migrateDb(sql) {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
}

// Truncate every application table so each run starts clean. The migrations
// bookkeeping lives in the `drizzle` schema, so a public-only truncate is safe.
export async function resetDb(sql) {
  const rows = await sql`
    select tablename from pg_tables where schemaname = 'public'`;
  const names = rows.map((r) => r.tablename);
  if (names.length === 0) return;
  const list = names.map((n) => `"${n}"`).join(", ");
  await sql.unsafe(`truncate table ${list} restart identity cascade`);
}

// Seed a user's kubeconfig, so the dashboard treats them as cluster-connected.
export async function seedKubeconfig(sql, userId, kubeconfig) {
  await sql`
    insert into user_kubeconfig (user_id, kubeconfig)
    values (${userId}, ${kubeconfig})
    on conflict (user_id) do update set kubeconfig = excluded.kubeconfig`;
}

// Look up a user's id by email (sign-up creates the row; specs seed against it).
export async function userIdByEmail(sql, email) {
  const [row] = await sql`select id from "user" where email = ${email} limit 1`;
  return row?.id ?? null;
}
