import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// vitest globalSetup: bring a real, throwaway Postgres up to the production
// schema before any integration test runs. Applying the migrations (rather than
// a one-shot schema push) is exactly what production does — proven by the CI
// db-migrate job — and additionally guards migration/schema drift.
//
// DATABASE_URL must point at a database that is safe to migrate and truncate.
// Locally: `docker run -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
//   -e POSTGRES_DB=bandolier_test -p 5433:5432 postgres:16`, then
// `DATABASE_URL=postgresql://test:test@localhost:5433/bandolier_test \
//   pnpm test:integration`. In CI a `services: postgres:16` container supplies it.
export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Integration tests need DATABASE_URL set to a throwaway Postgres. " +
        "See the header of src/test/integration/global-setup.ts for how to start one.",
    );
  }

  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}
