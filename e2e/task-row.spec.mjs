// Browser smoke test for the TaskRow Actions cell: revealing the confirm/cancel
// pair by tapping the terminate (×) glyph must not change the row's height on a
// mobile-width viewport. The confirm/cancel buttons used to wrap onto a second
// line in the slim Actions column, growing the row and shoving every row below
// it downward.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/task-row.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.TASK_ROW_BASE_URL ?? "http://localhost:3137";
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
// A narrow, phone-width viewport where the Actions column is at its slimmest.
const page = await browser.newPage({ viewport: { width: 360, height: 720 } });

await page.goto(`${BASE}/dev/task-row`);

const row = page.locator("[data-testid='rows'] tr");
const rowHeight = async () => (await row.boundingBox()).height;

const glyphHeight = await rowHeight();

await page.getByRole("button", { name: "Terminate agent" }).click();
check(
  "confirm/cancel pair is revealed",
  (await page.getByRole("button", { name: "Confirm" }).count()) === 1 &&
    (await page.getByRole("button", { name: "Cancel" }).count()) === 1,
);

const confirmHeight = await rowHeight();
check(
  `row height is unchanged (${glyphHeight}px → ${confirmHeight}px)`,
  Math.abs(confirmHeight - glyphHeight) < 1,
);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
