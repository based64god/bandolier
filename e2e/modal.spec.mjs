// Browser smoke test for the shared Modal shell.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/modal.spec.mjs
import { BASE, check, launch, finish } from "./helpers.mjs";

const browser = await launch();
const page = await browser.newPage();
const closes = () => page.getByTestId("closes").innerText();

await page.goto(`${BASE}/dev/modal`);
const panel = page.getByRole("dialog");
await panel.waitFor({ state: "visible", timeout: 5000 });

// ── Body scroll is locked while the modal is open ────────────────────────────
// The lock is applied in a client effect after hydration, so the dialog can be
// visible (SSR paint) before body.style.overflow is set — poll instead of a
// one-shot read.
const scrollLocked = await page
  .waitForFunction(() => document.body.style.overflow === "hidden", null, {
    timeout: 5000,
  })
  .then(() => true)
  .catch(() => false);
check("body scroll locked while open", scrollLocked);

// ── A drag that starts inside the panel and ends on the backdrop keeps it open
const box = await panel.boundingBox();
// Press inside the panel…
await page.mouse.move(box.x + box.width / 2, box.y + 20);
await page.mouse.down();
// …drag out to the top-left corner (backdrop) and release there.
await page.mouse.move(5, 5, { steps: 8 });
await page.mouse.up();
check("drag from panel to backdrop does NOT close", (await closes()) === "0");
check("modal still visible after drag", await panel.isVisible());

// ── A genuine backdrop click (down + up on the backdrop) closes it ───────────
await page.mouse.move(5, 5);
await page.mouse.down();
await page.mouse.up();
await panel.waitFor({ state: "hidden", timeout: 5000 });
check("backdrop click closes", (await closes()) === "1");

// ── Body scroll lock is released after close ─────────────────────────────────
const overflowAfterClose = await page.evaluate(
  () => document.body.style.overflow,
);
check("body scroll restored after close", overflowAfterClose !== "hidden");

// ── Escape closes the modal ──────────────────────────────────────────────────
await page.getByTestId("open").click();
await panel.waitFor({ state: "visible", timeout: 5000 });
await page.keyboard.press("Escape");
await panel.waitFor({ state: "hidden", timeout: 5000 });
check("Escape closes", (await closes()) === "2");

await finish(browser);
