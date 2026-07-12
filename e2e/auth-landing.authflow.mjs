// Authenticated product-flow test for the dashboard landing gate
// (src/app/_components/dashboard-entry.tsx): the server-side getSession branch.
//   - no session      → the marketing hero + "Sign in with Github"
//   - session, no k8s → the "Connect a cluster" empty state
// Proves the cookie → RSC-session → conditional product surface path works for
// real. No GitHub or Kubernetes needed: an email/password sign-up creates no
// GitHub account, so repos.list returns [] and no cluster is configured.
import { BASE, check, launch, finish } from "./helpers.mjs";
import { signUp, uniqueEmail } from "./auth-helper.mjs";

const browser = await launch();

// ── Unauthenticated: the marketing hero ──────────────────────────────────────
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  const tagline = await page
    .getByText("Claude agent monitoring", { exact: false })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check("unauthenticated landing shows the marketing hero", tagline);

  const signIn = await page
    .getByRole("button", { name: "Sign in with Github" })
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check("unauthenticated landing shows the sign-in button", signIn);
  await context.close();
}

// ── Authenticated, no cluster: the connect-a-cluster empty state ─────────────
{
  const { cookie } = await signUp(BASE, { email: uniqueEmail("landing") });
  const context = await browser.newContext();
  await context.addCookies([cookie]);
  const page = await context.newPage();
  await page.goto(BASE);

  // The dashboard shell renders for a signed-in user; with no kubeconfig the
  // kubeconfigStatus query resolves to unconfigured and the connect prompt shows.
  const connect = await page
    .getByText("Connect a cluster", { exact: false })
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check("authenticated dashboard shows the connect-a-cluster state", connect);

  // The marketing sign-in button is gone once authenticated.
  const signInGone = await page
    .getByRole("button", { name: "Sign in with Github" })
    .isVisible()
    .catch(() => false);
  check("the sign-in button is not shown once authenticated", !signInGone);
  await context.close();
}

await finish(browser);
