import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { GATE_COOKIE, gateToken, safeFrom, timingSafeEqual } from "~/lib/gate";

export async function POST(req: NextRequest) {
  const password = env.APP_PASSWORD;
  if (!password) {
    // Gate disabled — nothing to do.
    return NextResponse.redirect(new URL("/", req.url));
  }

  const form = await req.formData();
  const passwordField = form.get("password");
  const fromField = form.get("from");
  const provided = typeof passwordField === "string" ? passwordField : "";
  const from = safeFrom(typeof fromField === "string" ? fromField : "/");

  // Constant-time compare on equal-length inputs; bail fast on length mismatch.
  const ok =
    provided.length === password.length && timingSafeEqual(provided, password);

  if (!ok) {
    const url = new URL("/gate", req.url);
    url.searchParams.set("error", "1");
    url.searchParams.set("from", from);
    return NextResponse.redirect(url, { status: 303 });
  }

  const token = await gateToken(password, env.BETTER_AUTH_SECRET ?? "");
  const res = NextResponse.redirect(new URL(from, req.url), { status: 303 });
  res.cookies.set(GATE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
