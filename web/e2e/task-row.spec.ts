// Browser smoke test for the TaskRow Actions cell: revealing the confirm/cancel
// pair by tapping the terminate (×) glyph must not change the row's height on a
// mobile-width viewport. The confirm/cancel buttons used to wrap onto a second
// line in the slim Actions column, growing the row and shoving every row below
// it downward.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/task-row.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
// A narrow, phone-width viewport where the Actions column is at its slimmest.
const page = await browser.newPage({ viewport: { width: 360, height: 720 } });

await page.goto(`${BASE}/dev/task-row`);

// The harness renders extra worst-case rows for layout measurement; this spec
// exercises only the first (the original running manual task).
const row = page.locator("[data-testid='rows'] tr").first();
const rowHeight = async () => (await row.boundingBox())!.height;

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
if (!cellBox || !labelBox) throw new Error("pending cell/label has no box");
// Distance from the label's right edge to the cell's right edge — only the
// cell's right padding when the description fills the column.
const rightGap = cellBox.x + cellBox.width - (labelBox.x + labelBox.width);
check(
  `pending description fills the column (trailing label pinned right, gap ${rightGap.toFixed(0)}px)`,
  rightGap < 32,
);

// Regression: an ad-hoc task's stored display name is only a 60-char server
// preview of the prompt. The cell must render the full prompt (taskNameLabel)
// so a wide Task column truncates at its own edge, not at the preview — the
// first harness row carries exactly that preview-plus-prompt shape.
const firstTaskText = await wide
  .locator("[data-testid='rows'] tr")
  .first()
  .locator("td")
  .nth(2)
  .locator("span[title]")
  .textContent();
if (firstTaskText === null) throw new Error("task cell has no text");
check(
  `task cell renders the full prompt, not the 60-char preview (${firstTaskText.length} chars)`,
  firstTaskText.length > 61 && !firstTaskText.endsWith("…"),
);
await wide.close();

// Regression: a resumed run shows an amber "↻ resumed" lineage chip in the Task
// cell, beside the token readout. On a phone-width viewport the chip must not
// shove the token count out of the cell — an over-wide Status/Output column used
// to starve the Task column, pushing the readout past the cell's right edge
// toward the action controls. The harness renders a dedicated resumed row that
// also reports tokens (worst case: the widest 5-char count). 390px is the most
// common phone width (iPhone 12–15).
const phone = await browser.newPage({ viewport: { width: 390, height: 720 } });
await phone.goto(`${BASE}/dev/task-row`);
const resumedRow = phone
  .locator("[data-testid='rows'] tr", { hasText: "resumed" })
  .first();
const taskCellBox = await resumedRow.locator("td").nth(2).boundingBox();
const tokenBox = await resumedRow
  .locator("span[aria-label*='tokens used']")
  .boundingBox();
if (!taskCellBox || !tokenBox)
  throw new Error("resumed row cell/token has no box");
// Distance the token's right edge runs past the Task cell's right edge; ≤0 means
// the readout is fully contained.
const tokenOverflow =
  tokenBox.x + tokenBox.width - (taskCellBox.x + taskCellBox.width);
check(
  `resumed chip keeps the token inside the Task cell (overflow ${tokenOverflow.toFixed(0)}px)`,
  tokenOverflow <= 2,
);
await phone.close();

// Feature: the "↻ resumed" chip is a jump-to-parent control — clicking it
// scrolls the row of the run this task resumed from into view, so the lineage is
// followable a step at a time. The harness renders that parent row (jobName
// "task-parent-xyz") below the resumed row; on a short viewport it starts below
// the fold and must be on screen after the click.
const scroll = await browser.newPage({
  viewport: { width: 1200, height: 300 },
});
await scroll.goto(`${BASE}/dev/task-row`);
const parentRow = scroll.locator('[data-job-name="task-parent-xyz"]');
const parentTop = () =>
  parentRow.evaluate((el) => el.getBoundingClientRect().top);
const beforeTop = await parentTop();
check(
  `parent row starts below the fold (top ${beforeTop.toFixed(0)}px)`,
  beforeTop > 300,
);

await scroll
  .locator("[data-testid='rows'] tr", { hasText: "resumed" })
  .first()
  .getByRole("button", { name: /resumed/ })
  .click();
// Let the smooth scroll settle.
await scroll.waitForTimeout(800);
const afterTop = await parentTop();
check(
  `clicking the resumed chip scrolls the parent row into view (top ${beforeTop.toFixed(0)}px → ${afterTop.toFixed(0)}px)`,
  afterTop >= 0 && afterTop < 300,
);
await scroll.close();

await finish(browser);
