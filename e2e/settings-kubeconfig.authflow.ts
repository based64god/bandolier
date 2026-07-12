// Authenticated product-flow test for the settings kubeconfig setter
// (src/app/settings/_components/infrastructure-sections.tsx →
// account.setKubeconfig → validateKubeconfig). Exercises the validate-then-store
// path against a REACHABLE cluster: the submitted kubeconfig points at the fake
// Kubernetes server, so the server-side SSRF guard passes (127.0.0.1) and the
// live GET /version succeeds, the row is upserted, and a reload shows it
// configured. The only flow that drives the setter end-to-end against a cluster.
import { BASE, check, launch, finish } from "./helpers.ts";
import { signUp, uniqueEmail } from "./auth-helper.ts";

const K8S = process.env.E2E_FAKE_K8S_URL;
if (!K8S) {
  console.error("E2E_FAKE_K8S_URL not set — run via authflow-run.ts");
  process.exit(1);
}

// A self-contained, token-based kubeconfig (validateKubeconfig rejects exec /
// auth-provider / file-based auth) pointed at the fake cluster.
const kubeconfig = `apiVersion: v1
kind: Config
clusters:
  - name: fake
    cluster:
      server: ${K8S}
      insecure-skip-tls-verify: true
contexts:
  - name: fake
    context:
      cluster: fake
      user: fake
current-context: fake
users:
  - name: fake
    user:
      token: fake-token
`;

const browser = await launch();
const { cookie } = await signUp(BASE, { email: uniqueEmail("settings") });
const context = await browser.newContext();
await context.addCookies([cookie]);
const page = await context.newPage();

// The settings shell mounts only the active nav group; the #kubeconfig hash
// selects the "infrastructure" group so the kubeconfig card renders.
await page.goto(`${BASE}/settings#kubeconfig`);

const textarea = page.getByPlaceholder(/apiVersion: v1/).first();
await textarea.waitFor({ state: "visible", timeout: 20_000 });
await textarea.fill(kubeconfig);
await page.getByRole("button", { name: "Save & verify" }).click();

// validateKubeconfig hit the fake cluster's /version and returned its version.
const saved = await page
  .getByText(/Saved and verified/)
  .waitFor({ state: "visible", timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
check("kubeconfig validates against the fake cluster and saves", saved);

// It persisted: a reload shows the configured state (kubeconfigStatus reads the
// upserted row).
await page.reload();
const configured = await page
  .getByText("A kubeconfig is configured.")
  .waitFor({ state: "visible", timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
check("the kubeconfig persists as configured after reload", configured);

await finish(browser);
