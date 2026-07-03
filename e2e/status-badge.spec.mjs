// Browser smoke test for the StatusBadge failure popover: a Failed pill with
// failure detail opens a reason + suggested fix on tap, without triggering the
// surrounding row's click handler.
// Playwright is installed globally in this environment; resolve it locally
// first, else fall back to the global install.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/status-badge.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.STATUS_BADGE_BASE_URL ?? "http://localhost:3137";
let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
const popover = () => page.getByRole("dialog", { name: "Failure details" });
const rowClicks = () => page.getByTestId("row-clicks").innerText();

await page.goto(`${BASE}/dev/status-badge`);

// ── OOM kill: tap opens reason + suggested fix ───────────────────────────────
const oomBadge = page.getByTestId("oom").getByRole("button");
check("OOM badge is a tappable button", (await oomBadge.count()) === 1);

await oomBadge.click();
check("tap opens the failure popover", await popover().isVisible());
check(
  "popover names the OOM kill",
  (await popover().innerText()).includes("Out of memory"),
);
check(
  "popover suggests raising the memory limit",
  (await popover().innerText()).includes("memory limit"),
);
check("badge tap does not bubble to the row", (await rowClicks()) === "0");

// ── Escapes the overflow-hidden wrapper ──────────────────────────────────────
const clip = await page
  .getByTestId("oom")
  .locator("xpath=ancestor::div[contains(@class,'overflow-hidden')]")
  .boundingBox();
const box = await popover().boundingBox();
check(
  "popover escapes the clipping wrapper",
  box !== null && clip !== null && box.y + box.height > clip.y + clip.height,
);

// ── Dismissal ────────────────────────────────────────────────────────────────
await oomBadge.click();
check("second tap closes the popover", (await popover().count()) === 0);

await oomBadge.click();
await page.keyboard.press("Escape");
check("Escape closes the popover", (await popover().count()) === 0);

await oomBadge.click();
await page.getByRole("heading", { name: "StatusBadge harness" }).click();
check("outside tap closes the popover", (await popover().count()) === 0);

// ── Crash detail ─────────────────────────────────────────────────────────────
await page.getByTestId("crash").getByRole("button").click();
const crashText = await popover().innerText();
check("crash popover shows the exit code", crashText.includes("code 1"));
check(
  "crash popover surfaces the container message",
  crashText.includes("panic: boom"),
);
check(
  "crash popover points at the logs",
  crashText.toLowerCase().includes("logs"),
);
await page.keyboard.press("Escape");

// ── Non-interactive pills stay plain spans ───────────────────────────────────
check(
  "Failed without detail stays a plain pill",
  (await page.getByTestId("failed-no-detail").getByRole("button").count()) ===
    0,
);
check(
  "Succeeded stays a plain pill",
  (await page.getByTestId("succeeded").getByRole("button").count()) === 0,
);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
