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

// The harness renders extra worst-case rows for layout measurement; this spec
// exercises only the first (the original running manual task).
const row = page.locator("[data-testid='rows'] tr").first();
const rowHeight = async () => (await row.boundingBox()).height;

const glyphHeight = await rowHeight();

await row.getByRole("button", { name: "Terminate agent" }).click();
check(
  "confirm/cancel pair is revealed",
  (await row.getByRole("button", { name: "Confirm" }).count()) === 1 &&
    (await row.getByRole("button", { name: "Cancel" }).count()) === 1,
);

const confirmHeight = await rowHeight();
check(
  `row height is unchanged (${glyphHeight}px → ${confirmHeight}px)`,
  Math.abs(confirmHeight - glyphHeight) < 1,
);

// Regression: a task description must fill its Task column so it only truncates
// where it would meet the trailing element on its right (the token counter on a
// live row, the "propagating…" label on a just-deployed row) — not at its own
// content width, which left the trailing element hugging a short name with the
// rest of the wide column empty. Checked on the pending row, whose short name
// sits well inside a wide Task column: filling pins "propagating…" to the
// column's right edge.
const wide = await browser.newPage({ viewport: { width: 1600, height: 720 } });
await wide.goto(`${BASE}/dev/task-row`);
const pendingCell = wide
  .locator("[data-testid='rows'] tr", { hasText: "propagating…" })
  .locator("td")
  .nth(2);
const cellBox = await pendingCell.boundingBox();
const labelBox = await pendingCell.getByText("propagating…").boundingBox();
// Distance from the label's right edge to the cell's right edge — only the
// cell's right padding when the description fills the column.
const rightGap = cellBox.x + cellBox.width - (labelBox.x + labelBox.width);
check(
  `pending description fills the column (trailing label pinned right, gap ${rightGap.toFixed(0)}px)`,
  rightGap < 32,
);
await wide.close();

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
