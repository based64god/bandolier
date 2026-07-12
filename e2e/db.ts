// Direct database access for the authenticated browser product-flow specs
// (e2e/*.authflow.ts), used by the runner (authflow-run.ts) to migrate + reset
// the throwaway Postgres and by specs to seed rows the UI reads. Uses raw SQL via
// the `postgres` driver so this stays free of the app's TS schema imports.
import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for authenticated flows");
  return postgres(url, { max: 1 });
}

// Bring the database up to the production schema (the same migrations the app
// and the integration globalSetup apply).
export async function migrateDb(sql: Sql): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
}

// Truncate every application table so each run starts clean. The migrations
// bookkeeping lives in the `drizzle` schema, so a public-only truncate is safe.
export async function resetDb(sql: Sql): Promise<void> {
  const rows = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'`;
  const names = rows.map((r) => r.tablename);
  if (names.length === 0) return;
  const list = names.map((n) => `"${n}"`).join(", ");
  await sql.unsafe(`truncate table ${list} restart identity cascade`);
}

// Seed a user's kubeconfig, so the dashboard treats them as cluster-connected.
// created_at/updated_at are app-layer defaults (drizzle $defaultFn), not DB
// defaults, so raw SQL must set them.
export async function seedKubeconfig(
  sql: Sql,
  userId: string,
  kubeconfig: string,
): Promise<void> {
  await sql`
    insert into user_kubeconfig (user_id, kubeconfig, created_at, updated_at)
    values (${userId}, ${kubeconfig}, now(), now())
    on conflict (user_id) do update
      set kubeconfig = excluded.kubeconfig, updated_at = now()`;
}

// Look up a user's id by email (sign-up creates the row; specs seed against it).
export async function userIdByEmail(
  sql: Sql,
  email: string,
): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from "user" where email = ${email} limit 1`;
  return row?.id ?? null;
}

// Seed a linked GitHub account so getUserGithubToken returns a token (email
// sign-up creates only a "credential" account). The token is used only by the
// stubbed GitHub calls (e2e/stub-preload.ts).
export async function seedGithubAccount(
  sql: Sql,
  userId: string,
  accessToken = "gho_e2e",
): Promise<void> {
  await sql`
    insert into account (id, account_id, provider_id, user_id, access_token, created_at, updated_at)
    values (${randomUUID()}, ${"gh-" + userId}, 'github', ${userId}, ${accessToken}, now(), now())`;
}

// Seed an Anthropic API key so the user has a usable model provider to deploy.
export async function seedAnthropicCredential(
  sql: Sql,
  userId: string,
  apiKey = "sk-ant-e2e",
): Promise<void> {
  await sql`
    insert into user_anthropic_credentials (user_id, api_key, created_at, updated_at)
    values (${userId}, ${apiKey}, now(), now())`;
}
