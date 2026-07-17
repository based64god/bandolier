// Browser smoke test for the deploy form (DeployModal). Drives the harness at
// /dev/deploy-modal, whose scenarios pre-seed the tRPC cache so the modal reads
// provider/model/issue fixtures without a backend. The deploy mutation POST is
// intercepted here so submit can complete offline.
//
// Covers: model resolution, required-field validation, the issue-selection
// path, the PR-review dropdown path (including the typed off-list PR-number
// fallback), and the repo-credentials provider source.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/deploy-modal.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
const page = await browser.newPage();

// Stub the one request the modal makes on its own — the deploy mutation on
// submit — with a jsonl-framed success body (what the httpBatchStreamLink
// expects). Everything else resolves from the seeded cache.
const captured: {
  payload: Record<string, { json?: Record<string, unknown> }> | null;
} = { payload: null };
await page.route("**/api/trpc/agents.deploy**", async (route) => {
  const req = route.request();
  if (req.method() !== "POST") return route.continue();
  captured.payload = req.postDataJSON() as Record<
    string,
    { json?: Record<string, unknown> }
  >;
  await route.fulfill({
    status: 200,
    headers: { "content-type": "application/jsonl" },
    body:
      JSON.stringify({
        json: { 0: [[{ result: { data: { jobName: "task-mock-123" } } }]] },
      }) + "\n",
  });
});

const dialog = page.getByRole("dialog");
const deployBtn = () => page.getByRole("button", { name: "Deploy", exact: true });
const openScenario = async (id: string) => {
  await page.getByTestId(`open-${id}`).click();
  await dialog.waitFor({ state: "visible", timeout: 8000 });
};

await page.goto(`${BASE}/dev/deploy-modal`);

// ── Model resolution ─────────────────────────────────────────────────────────
await openScenario("repo");
check("modal opens with the Deploy Agent title", await dialog.isVisible());
check(
  "model defaults to a Sonnet (resolveEffectiveModel fallback)",
  (await dialog.innerText()).includes("Claude Sonnet 5"),
);
check(
  "reasoning-effort picker shows for a Claude model",
  (await dialog.innerText()).includes("Reasoning effort"),
);

// ── Required-field validation ────────────────────────────────────────────────
check("Deploy is disabled with an empty task", await deployBtn().isDisabled());
await page.locator("textarea").fill("investigate the flaky test");
check(
  "Deploy enables once a task is entered",
  await deployBtn().isEnabled(),
);

// ── The effort picker stays for every provider ───────────────────────────────
// Reasoning effort applies to every provider (providerSupportsEffort is
// universal), so switching to a non-Claude model keeps the picker visible.
// Anchor the model picker to its "Model" label — its shown value changes as we
// switch models, so the label is the only stable handle.
const modelTrigger = dialog
  .locator("div.space-y-1", { has: page.getByText("Model", { exact: true }) })
  .getByRole("button")
  .first();
await modelTrigger.click();
const modelSearch = page.getByPlaceholder("Search models…");
await modelSearch.waitFor({ state: "visible", timeout: 5000 });
await modelSearch.fill("GPT");
await page.getByText("GPT-5.5").click();
check(
  "effort picker stays for an OpenAI model (effort applies to every provider)",
  (await dialog.innerText()).includes("Reasoning effort"),
);

// Switch back to a Claude model so the deploy sends the provider asserted below.
await modelTrigger.click();
await modelSearch.waitFor({ state: "visible", timeout: 5000 });
await modelSearch.fill("Opus");
await page.getByText("Claude Opus 4.8").click();
check(
  "effort picker stays for a Claude model",
  (await dialog.innerText()).includes("Reasoning effort"),
);

// ── Submit deploys and closes ────────────────────────────────────────────────
await deployBtn().click();
await dialog.waitFor({ state: "hidden", timeout: 8000 });
check(
  "deploy payload carries the task",
  captured.payload?.["0"]?.json?.task === "investigate the flaky test",
);
check(
  "deploy payload carries the chosen model + provider",
  captured.payload?.["0"]?.json?.model === "claude-opus-4-8" &&
    captured.payload?.["0"]?.json?.modelProvider === "anthropic",
);
check(
  "onDeployed fires with the created job name",
  (await page.getByTestId("deployed").innerText()).startsWith("task-mock-123|"),
);
check("modal closed after deploy", (await page.getByTestId("closes").innerText()) === "1");

// ── Issue-selection path ─────────────────────────────────────────────────────
await openScenario("repo");
// With a repo, the GitHub-issue select and the PR/issue output toggle appear.
check(
  "output toggle offers Pull request + GitHub issue",
  (await dialog.getByRole("button", { name: "Pull request" }).count()) === 1 &&
    (await dialog.getByRole("button", { name: "GitHub issue" }).count()) === 1,
);
const issueTrigger = page
  .getByRole("dialog")
  .getByText("No issue — freeform task")
  .locator("xpath=ancestor::button[1]");
await issueTrigger.click();
const issueSearch = page.getByPlaceholder("Search issues…");
await issueSearch.waitFor({ state: "visible", timeout: 5000 });
await issueSearch.fill("coverage");
await page.getByText("e2e coverage gaps").click();
check(
  "selecting an issue makes the task field optional (no required task)",
  (await dialog.innerText()).includes("Additional context"),
);
check(
  "an issue selection satisfies validation without a typed task",
  await deployBtn().isEnabled(),
);
await deployBtn().click();
await dialog.waitFor({ state: "hidden", timeout: 8000 });
check(
  "deploy payload carries the selected issue number",
  captured.payload?.["0"]?.json?.issueNumber === 235,
);

// ── PR-review dropdown path ──────────────────────────────────────────────────
await openScenario("repo");
await dialog.getByRole("button", { name: "PR review" }).click();
const prTrigger = page
  .getByRole("dialog")
  .getByText("Select a pull request to review")
  .locator("xpath=ancestor::button[1]");
await prTrigger.click();
const prSearch = page.getByPlaceholder("Search or type a PR number…");
await prSearch.waitFor({ state: "visible", timeout: 5000 });
await prSearch.fill("popover");
await page.getByText("Fix status badge popover flicker").click();
check(
  "selecting a PR satisfies validation without a typed task",
  await deployBtn().isEnabled(),
);
await deployBtn().click();
await dialog.waitFor({ state: "hidden", timeout: 8000 });
check(
  "deploy payload carries the selected PR number and review output",
  captured.payload?.["0"]?.json?.reviewPrNumber === 131 &&
    captured.payload?.["0"]?.json?.outputType === "review",
);

// ── Typed-number fallback for an off-list PR ──────────────────────────────────
// A PR that isn't in the fetched open-PR list (closed/merged, or beyond the
// 100-open cap) is still reviewable by typing its number.
await openScenario("repo");
await dialog.getByRole("button", { name: "PR review" }).click();
await page
  .getByRole("dialog")
  .getByText("Select a pull request to review")
  .locator("xpath=ancestor::button[1]")
  .click();
const prSearch2 = page.getByPlaceholder("Search or type a PR number…");
await prSearch2.waitFor({ state: "visible", timeout: 5000 });
await prSearch2.fill("902");
await page.getByText("Review PR #902").click();
check(
  "a typed off-list PR number satisfies validation",
  await deployBtn().isEnabled(),
);
check(
  "the typed PR number shows in the trigger",
  (await dialog.innerText()).includes("Review PR #902"),
);
await deployBtn().click();
await dialog.waitFor({ state: "hidden", timeout: 8000 });
check(
  "deploy payload carries the typed off-list PR number",
  captured.payload?.["0"]?.json?.reviewPrNumber === 902 &&
    captured.payload?.["0"]?.json?.outputType === "review",
);

// ── Repo-credentials provider source ─────────────────────────────────────────
await openScenario("repo-creds");
check(
  "repo-credential scenario still resolves a model",
  (await dialog.innerText()).includes("Claude Sonnet 5"),
);

await finish(browser);
