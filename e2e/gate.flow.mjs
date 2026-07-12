// Browser product-flow test for the shared-password gate (src/proxy.ts — the
// Next 16 proxy/middleware). Complements the unit tests (proxy.test.ts asserts
// isExempt + the 401-vs-redirect split): here the REAL middleware runs in a real
// server, and the real /gate page form round-trips the cookie.
//
// Hermetic: the middleware-level checks use raw fetch (no cookie), and the form
// flow keeps from=/gate so the post-gate redirect lands on the exempt /gate page
// — nothing here touches the database, Kubernetes, or GitHub.
import { BASE, check, launch, finish } from "./helpers.mjs";

const PASSWORD = process.env.E2E_APP_PASSWORD ?? "flow-gate-secret";

// ── Middleware behavior at the HTTP level (no gate cookie) ───────────────────
const nav = await fetch(`${BASE}/`, { redirect: "manual" });
check(
  "locked app redirects a navigation to /gate",
  nav.status >= 300 &&
    nav.status < 400 &&
    (nav.headers.get("location") ?? "").includes("/gate"),
);

const api = await fetch(`${BASE}/api/trpc/agents.list`, { redirect: "manual" });
check("locked app 401s a non-exempt API request", api.status === 401);

const version = await fetch(`${BASE}/api/version`, { redirect: "manual" });
check("exempt /api/version is reachable while gated", version.status === 200);

// ── The gate page form ───────────────────────────────────────────────────────
const browser = await launch();
const page = await browser.newPage();

await page.goto(`${BASE}/gate?from=/gate`);
await page.getByLabel("Password").waitFor({ state: "visible", timeout: 10_000 });

// Wrong password → the page re-renders with the error.
await page.getByLabel("Password").fill("definitely-wrong");
await page.getByRole("button", { name: "Continue" }).click();
const errorShown = await page
  .getByText("Incorrect password.")
  .waitFor({ state: "visible", timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
check("a wrong password shows the error", errorShown);

// Correct password → 303 back to /gate (from), setting the gate cookie.
await page.getByLabel("Password").fill(PASSWORD);
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForLoadState("networkidle").catch(() => {});

// The gate cookie is httpOnly, so read it from the context (not document.cookie).
const gateCookie = await page
  .context()
  .cookies()
  .then((cs) => cs.find((c) => c.name === "bandolier_gate"));
check(
  "the correct password sets the gate cookie",
  !!gateCookie && gateCookie.value.length > 0,
);

// With the cookie, an API request the gate previously 401'd now passes the gate
// (it may 4xx/5xx downstream without a DB, but it must NOT be the gate's 401).
const afterCookie = await page.request.get(`${BASE}/api/version`);
check(
  "an exempt route still 200s once admitted",
  afterCookie.status() === 200,
);

await finish(browser);
