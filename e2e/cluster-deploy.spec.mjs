// Browser smoke test for the one-click cluster deploy wizard
// (ClusterDeploySection). Drives the harness at /dev/cluster-deploy, whose
// scenarios pre-seed the tRPC cache so the section renders each screen without
// a backend. The mutations the section fires on its own (start, and the tick
// poll while a deployment is active) are intercepted here.
//
// Covers: the collapsed offer → form flow, required-field gating, the
// kubeconfig-overwrite warning, start → progress transition, the tick poll
// advancing progress → success, and the success/failure screens' contents.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/cluster-deploy.spec.mjs
import { BASE, check, launch, finish } from "./helpers.mjs";

const browser = await launch();
const page = await browser.newPage();

const deployment = (overrides = {}) => ({
  id: "dep-1",
  status: "pending",
  error: null,
  clusterName: "bandolier-abc123",
  region: "nyc3",
  nodeSize: "s-4vcpu-8gb",
  minNodes: 1,
  maxNodes: 4,
  spacesEnabled: true,
  clusterId: "c-1111",
  bucketName: "bandolier-abc123-artifacts",
  spacesEndpoint: "https://nyc3.digitaloceanspaces.com",
  spacesAccessKeyId: "DO_SCOPED_KEY",
  spacesSecretAccessKey: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

// jsonl-framed single-procedure success body (what httpBatchStreamLink expects).
const trpcBody = (data) =>
  JSON.stringify({ json: { 0: [[{ result: { data } }]] } }) + "\n";

let startPayload = null;
await page.route("**/api/trpc/clusterDeploy.start**", async (route) => {
  startPayload = route.request().postDataJSON();
  await route.fulfill({
    status: 200,
    headers: { "content-type": "application/jsonl" },
    body: trpcBody(deployment()),
  });
});

// Every tick reports the deployment finished — the spec's stand-in for the
// state machine reaching "done" server-side.
await page.route("**/api/trpc/clusterDeploy.tick**", (route) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "application/jsonl" },
    body: trpcBody(
      deployment({ status: "done", spacesSecretAccessKey: "scoped-secret" }),
    ),
  }),
);

let dismissed = false;
await page.route("**/api/trpc/clusterDeploy.dismiss**", (route) => {
  dismissed = true;
  return route.fulfill({
    status: 200,
    headers: { "content-type": "application/jsonl" },
    body: trpcBody(deployment({ status: "dismissed" })),
  });
});

const openScenario = async (id) => {
  await page.getByTestId(`open-${id}`).click();
};

await page.goto(`${BASE}/dev/cluster-deploy`);

// ── Collapsed offer → form, required-field gating ────────────────────────────
await openScenario("form");
const expand = page.getByRole("button", { name: "Deploy a cluster…" });
await expand.waitFor({ state: "visible", timeout: 8000 });
check("collapsed scenario shows the deploy offer", await expand.isVisible());
await expand.click();

const submit = page.getByRole("button", { name: "Deploy cluster" });
await submit.waitFor({ state: "visible", timeout: 5000 });
check("submit is disabled with no credentials", await submit.isDisabled());

await page.locator("#do-token").fill("dop_v1_e2e");
check(
  "submit enables with just the API token (no Spaces admin keys asked)",
  await submit.isEnabled(),
);
check(
  "the form never asks for Spaces admin keys",
  (await page.locator("#spaces-access-id").count()) === 0,
);

// ── Node-size dropdown is usable (regression: invisible native options) ──────
await page
  .getByRole("button", { name: /s-4vcpu-8gb — 4 vCPU/ })
  .click({ timeout: 5000 });
const sizeOption = page.getByText("s-8vcpu-16gb — 8 vCPU / 16 GB (~$96/mo)");
await sizeOption.waitFor({ state: "visible", timeout: 5000 });
check("node-size dropdown opens with visible options", true);
await sizeOption.click();
check(
  "picking a node size updates the trigger",
  await page.getByRole("button", { name: /s-8vcpu-16gb/ }).isVisible(),
);

// ── Start → progress ─────────────────────────────────────────────────────────
await submit.click();
const progress = page.getByTestId("cluster-deploy-progress");
await progress.waitFor({ state: "visible", timeout: 8000 });
check("submitting shows the progress screen", await progress.isVisible());
check(
  "start was called with the deploy shape (not just creds)",
  JSON.stringify(startPayload ?? {}).includes("nyc3"),
);

// ── Tick poll advances progress → success ────────────────────────────────────
// The section polls tick every 5s; our stub reports "done" on the first tick.
const success = page.getByTestId("cluster-deploy-success");
await success.waitFor({ state: "visible", timeout: 15000 });
check("the tick poll lands on the success screen", await success.isVisible());

// ── Overwrite warning ────────────────────────────────────────────────────────
await openScenario("form-overwrite");
await page
  .getByRole("button", { name: "Deploy a cluster…" })
  .click({ timeout: 8000 });
await page
  .getByText("You already have a kubeconfig configured", { exact: false })
  .waitFor({ state: "visible", timeout: 5000 });
check("existing kubeconfig shows the overwrite warning", true);

// ── Seeded progress screen ───────────────────────────────────────────────────
await openScenario("progress");
await progress.waitFor({ state: "visible", timeout: 8000 });
const progressText = await progress.innerText();
check(
  "progress lists the wizard steps",
  progressText.includes("Waiting for the cluster") &&
    progressText.includes("Bootstrapping agent kubeconfig"),
);
check(
  "progress offers cancel-and-cleanup",
  await page
    .getByRole("button", { name: "Cancel & delete created resources" })
    .isVisible(),
);

// ── Success screen contents ──────────────────────────────────────────────────
await openScenario("done");
await success.waitFor({ state: "visible", timeout: 8000 });
const successText = await success.innerText();
check(
  "success confirms the saved kubeconfig",
  successText.includes("kubeconfig has been saved"),
);
check(
  "success shows the artifact-storage outputs incl. the one-time secret",
  successText.includes("https://nyc3.digitaloceanspaces.com") &&
    successText.includes("scoped-secret-key"),
);
check(
  "success offers the terraform adoption bundle",
  (await page.getByRole("button", { name: "⬇ imports.tf" }).isVisible()) &&
    (await page
      .getByRole("button", { name: "⬇ terraform.tfvars" })
      .isVisible()),
);

// ── Failure screen ───────────────────────────────────────────────────────────
await openScenario("failed");
const failure = page.getByTestId("cluster-deploy-failure");
await failure.waitFor({ state: "visible", timeout: 8000 });
check(
  "failure surfaces the deployment error",
  (await failure.innerText()).includes('Cluster entered state "errored"'),
);
await Promise.all([
  page.waitForResponse((r) => r.url().includes("clusterDeploy.dismiss"), {
    timeout: 5000,
  }),
  page.getByRole("button", { name: "Dismiss, keep resources" }).click(),
]);
check("dismiss fires the dismiss mutation", dismissed);

await finish(browser);
