import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "~/server/db";

// Never cache — probes must reflect the live process and its DB connectivity.
export const dynamic = "force-dynamic";

/**
 * Health endpoint for Kubernetes probes.
 *
 * - **Liveness**: reaching this handler at all means the Node process is up and
 *   serving, so any 2xx/5xx response (i.e. the request completing) satisfies a
 *   liveness probe. Point the liveness probe here with a short timeout.
 * - **Readiness**: a ready replica must also be able to reach Postgres, so we
 *   run a trivial `SELECT 1`. If it fails we return 503 and the pod is pulled
 *   out of the Service until the database is reachable again.
 *
 * Both probes can target this same path; readiness is the stricter check.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json(
      { status: "ok", db: "ok" },
      { headers: { "cache-control": "no-store, max-age=0" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: "degraded",
        db: "unreachable",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }
}
