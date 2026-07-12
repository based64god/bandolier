// Auth bypass for the authenticated product-flow specs: mint a real better-auth
// session via email/password sign-up (emailAndPassword is enabled; no email
// verification), and return the session cookie as a Playwright cookie object.
// This produces the exact signed cookie the real middleware/getSession accept —
// no GitHub OAuth, no cookie-signing to reverse-engineer.

type SessionCookie = { name: string; value: string; url: string };

// signUp creates a user and returns { cookie, email }. Pass a unique email per
// spec run (the user table enforces uniqueness).
export async function signUp(
  base: string,
  {
    email,
    password = "correct-horse-battery",
    name = "E2E User",
  }: { email: string; password?: string; name?: string },
): Promise<{ cookie: SessionCookie; email: string }> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    // better-auth's CSRF guard requires an Origin matching the configured
    // baseURL (a browser sends this automatically; a raw fetch must set it).
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password, name }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  const setCookies = res.headers.getSetCookie();
  const raw = setCookies.find((c) =>
    c.startsWith("better-auth.session_token="),
  );
  if (!raw) throw new Error("no session cookie in sign-up response");
  const nameval = raw.split(";")[0] ?? "";
  const eq = nameval.indexOf("=");
  const cookie = {
    name: nameval.slice(0, eq),
    value: nameval.slice(eq + 1),
    url: base,
  };
  return { cookie, email };
}

// uniqueEmail returns a per-run unique address so re-runs don't collide.
export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}
