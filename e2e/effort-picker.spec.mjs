// Browser smoke test for the EffortPicker segmented control + Preferred toggle.
// Playwright is installed globally in this environment; resolve it locally
// first, else fall back to the global install.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/effort-picker.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.EFFORT_BASE_URL ?? "http://localhost:3137";
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
const value = () => page.getByTestId("value").innerText();
const preferred = () => page.getByTestId("preferred").innerText();

await page.goto(`${BASE}/dev/effort-picker`);

// ── All five levels + default are selectable ────────────────────────────────
check("starts on the default level", (await value()) === "default");

for (const level of ["low", "medium", "high", "xhigh", "max"]) {
  await page.getByRole("button", { name: level, exact: true }).click();
  check(`clicking '${level}' selects it`, (await value()) === level);
}

// ── Preferred toggle pins the current level ──────────────────────────────────
await page.getByRole("button", { name: "high", exact: true }).click();
await page.getByRole("checkbox").check();
check("Preferred pins the selected level", (await preferred()) === "high");

// Switching level leaves the old pin until re-toggled (mirrors the modal).
await page.getByRole("button", { name: "low", exact: true }).click();
check("changing level keeps the prior pin", (await preferred()) === "high");
await page.getByRole("checkbox").check();
check("re-checking re-pins to the new level", (await preferred()) === "low");

// ── Back to default clears the value, disabling the pin ──────────────────────
await page.getByRole("button", { name: "default", exact: true }).click();
check("can return to default", (await value()) === "default");
check("Preferred toggle disabled at default", await page.getByRole("checkbox").isDisabled());

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
