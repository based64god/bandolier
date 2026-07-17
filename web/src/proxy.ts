import { type NextRequest, NextResponse } from "next/server";

import { GATE_COOKIE, gateToken, timingSafeEqual } from "~/lib/gate";

// Prefix-matched exemptions: any path under one of these passes the gate.
//  - the GitHub webhooks (authenticate via HMAC signature; GitHub can't log in)
//  - the public REST API (authenticates via API key or session of its own)
export const EXEMPT_PREFIXES: readonly string[] = [
  "/api/webhooks/",
  "/api/v1/",
];

// Exact-matched exemptions: only these precise paths pass the gate. Kept as
// exact matches (not prefixes) so, e.g., /api/agent-runs/<anything> still 401s.
export const EXEMPT_EXACT: ReadonlySet<string> = new Set([
  // Harness callbacks — run output ingest, interactive input, and the ACP
  // relay — which authenticate via a per-job HMAC token (the in-pod harness has
  // no session/password to present). Every route under src/app/api that calls
  // verifyIngestToken must be represented here; proxy.test.ts asserts this.
  "/api/agent-runs",
  "/api/agent-runs/review",
  "/api/agent-input",
  "/api/acp",
  // The version endpoint (just a build id; clients poll it to detect deploys).
  "/api/version",
  // The health endpoint (liveness/readiness for k8s probes; no secrets).
  "/api/health",
  // The kubeconfig setup script (no secrets; meant for `curl … | bash`).
  "/setup.sh",
  // The gate page + its submit endpoint.
  "/gate",
  "/api/gate",
  // The app icon / OG image (only reveal the logo + tagline; lets unfurls work).
  "/icon.svg",
  "/apple-icon",
  "/opengraph-image",
  "/favicon.ico",
  // The PWA manifest, service worker, and install icons — the browser must be
  // able to fetch these (as JSON/JS/PNG, not the gate's HTML) for the app to be
  // installable, even before the user passes the gate. They expose no secrets.
  "/manifest.webmanifest",
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
]);

export function isExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  // Gate disabled when no password is configured — app behaves as normal.
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isExempt(pathname)) return NextResponse.next();

  const expected = await gateToken(
    password,
    process.env.BETTER_AUTH_SECRET ?? "",
  );
  const cookie = req.cookies.get(GATE_COOKIE)?.value;
  if (cookie && timingSafeEqual(cookie, expected)) {
    return NextResponse.next();
  }

  // Unauthenticated. API/data requests get a 401; navigations go to the gate.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Password required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  url.search = "";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next's static assets.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
