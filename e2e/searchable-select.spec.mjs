// Browser smoke test for SearchableSelect arrow-key navigation. Playwright is
// installed globally in this environment; resolve it locally first, else fall
// back to the global install.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/searchable-select.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.SELECT_BASE_URL ?? "http://localhost:3137";
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

await page.goto(`${BASE}/dev/searchable-select`);
const trigger = page.getByRole("button").first();

// ── Open with the keyboard from the closed trigger ───────────────────────────
await trigger.focus();
await trigger.press("ArrowDown");
const search = page.getByPlaceholder("Search…");
await search.waitFor({ state: "visible", timeout: 5000 });
check("ArrowDown on closed trigger opens the panel", await search.isVisible());

// Initial value is "beta"; the highlight should start on the selected row, so
// ArrowDown lands on "gamma" (beta+1).
await search.press("ArrowDown");
await search.press("Enter");
check("ArrowDown from selection + Enter picks 'gamma'", (await value()) === "gamma");

// ── ArrowUp wraps / walks backward ───────────────────────────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
// Highlight starts on "gamma" (index 3 incl. None row). ArrowUp → "beta".
await search.press("ArrowUp");
await search.press("Enter");
check("ArrowUp from selection + Enter picks 'beta'", (await value()) === "beta");

// ── End jumps to the last row, Enter selects it ──────────────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
await search.press("End");
await search.press("Enter");
check("End + Enter picks last option 'epsilon'", (await value()) === "epsilon");

// ── Home jumps to the first row (the "None" clear row) ───────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
await search.press("Home");
await search.press("Enter");
check("Home + Enter picks the clear/None row", (await value()) === "null");

// ── ArrowUp from the top wraps to the bottom ─────────────────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
// value is null → highlight starts at 0 (None). ArrowUp wraps to last (epsilon).
await search.press("ArrowUp");
await search.press("Enter");
check("ArrowUp from first row wraps to last 'epsilon'", (await value()) === "epsilon");

// ── Typing filters, then arrow nav walks the filtered list ───────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
await search.type("a");
// Filtered: alpha, gamma, delta. Highlight reset to 0 → alpha. Enter picks it.
await search.press("Enter");
check("typing 'a' + Enter picks first match 'alpha'", (await value()) === "alpha");

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
