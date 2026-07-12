// The flagship authenticated flow: deploy an agent from the repo dashboard, watch
// its pod surface in the task list, and open its logs — all against a real
// Postgres, a fake Kubernetes cluster, and a stubbed GitHub. Verifies the whole
// authenticated deploy→observe→logs contract (authz, kubeconfig resolution, job
// creation, pod listing, log reading) end to end.
import { BASE, check, launch, finish } from "./helpers.ts";
import { signUp, uniqueEmail } from "./auth-helper.ts";
import {
  connect,
  seedAnthropicCredential,
  seedGithubAccount,
  seedKubeconfig,
  userIdByEmail,
} from "./db.ts";

const K8S = process.env.E2E_FAKE_K8S_URL;
const REPO = process.env.E2E_GH_REPO ?? "acme/widgets";
if (!K8S) {
  console.error("E2E_FAKE_K8S_URL not set — run via authflow-run.ts");
  process.exit(1);
}

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

const TASK = "e2e-deploy-probe investigate the widget";

const browser = await launch();
const { cookie, email } = await signUp(BASE, { email: uniqueEmail("deploy") });

// Seed the linked GitHub account (so repos.list returns the stubbed repo), the
// kubeconfig (pointed at the fake cluster), and an Anthropic credential (a
// deployable model).
const sql = connect();
const userId = await userIdByEmail(sql, email);
if (!userId) throw new Error(`no user row for ${email}`);
await seedGithubAccount(sql, userId);
await seedKubeconfig(sql, userId, kubeconfig);
await seedAnthropicCredential(sql, userId);
await sql.end();

const context = await browser.newContext();
await context.addCookies([cookie]);
const page = await context.newPage();

// Land on the repo dashboard; the Deploy button appears once repos.list (via the
// stubbed GitHub) and the kubeconfig both resolve.
await page.goto(`${BASE}/repo/${REPO}`);
const deployTrigger = page.getByRole("button", { name: /Deploy Agent/ });
const trigVisible = await deployTrigger
  .waitFor({ state: "visible", timeout: 25_000 })
  .then(() => true)
  .catch(() => false);
check(
  "repo dashboard shows the Deploy button (repos + kubeconfig resolved)",
  trigVisible,
);

// Open the deploy modal, enter a task, deploy.
await deployTrigger.click();
const dialog = page.getByRole("dialog");
await dialog.waitFor({ state: "visible", timeout: 10_000 });
await page.locator("textarea").first().fill(TASK);

const deployBtn = page.getByRole("button", { name: "Deploy", exact: true });
await deployBtn.waitFor({ state: "visible", timeout: 10_000 });
// The model list loads async (models.list); Deploy enables once a default model
// resolves from the seeded Anthropic credential — poll rather than snapshot.
let enabled = false;
for (let i = 0; i < 40 && !enabled; i++) {
  enabled = await deployBtn.isEnabled().catch(() => false);
  if (!enabled) await new Promise((r) => setTimeout(r, 250));
}
check("Deploy is enabled once a task and default model are set", enabled);
await deployBtn.click();

// The deploy created a job → the fake cluster synthesized a Running pod. Reload
// to drop the client-only optimistic placeholder and read the real pod back
// from agents.list.
await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
await new Promise((r) => setTimeout(r, 2000));
await page.goto(`${BASE}/repo/${REPO}`);

const row = page.getByText("e2e-deploy-probe", { exact: false }).first();
const rowVisible = await row
  .waitFor({ state: "visible", timeout: 25_000 })
  .then(() => true)
  .catch(() => false);
check("the deployed task's pod surfaces in the task list", rowVisible);

// Clicking the row opens the LogModal → agents.getLogs → the fake pod's log.
await row.click();
const logShown = await page
  .getByText(/e2e-fake-agent-log/)
  .waitFor({ state: "visible", timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
check("opening the task shows the pod's logs", logShown);

await finish(browser);
