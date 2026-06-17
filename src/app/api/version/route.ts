import { NextResponse } from "next/server";

// The build id baked in at build time (next.config.js → env.NEXT_PUBLIC_BUILD_ID).
// Read once at module load; it never changes for the life of a server process.
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

// Always reflect the live server's build, never a cached value.
export const dynamic = "force-dynamic";

/**
 * Reports the build id of the running server. Clients poll this and compare it
 * with the build id they were served (NEXT_PUBLIC_BUILD_ID, baked into their
 * bundle). A mismatch means a newer build has been deployed and the client is
 * out of date — the UI then prompts the user to refresh.
 */
export function GET() {
  return NextResponse.json(
    { buildId: BUILD_ID },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
