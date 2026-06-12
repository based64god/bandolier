import { type NextRequest, NextResponse } from "next/server";

import { GATE_COOKIE, gateToken, timingSafeEqual } from "~/lib/gate";

// Paths reachable without passing the gate:
//  - the GitHub webhook (authenticates via HMAC signature; GitHub can't log in)
//  - the public REST API (authenticates via API key or session of its own)
//  - the gate page + its submit endpoint
//  - the app icon / OG image (only reveal the logo + tagline; lets unfurls work)
//  - the kubeconfig setup script (no secrets; meant for `curl … | bash`)
function isExempt(pathname: string): boolean {
  return (
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/v1/") ||
    pathname === "/api/agent-runs" ||
    pathname === "/api/agent-input" ||
    pathname === "/setup.sh" ||
    pathname === "/gate" ||
    pathname === "/api/gate" ||
    pathname === "/icon.svg" ||
    pathname === "/apple-icon" ||
    pathname === "/opengraph-image" ||
    pathname === "/favicon.ico"
  );
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
