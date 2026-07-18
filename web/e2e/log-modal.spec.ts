// Browser smoke test for the log modal's Retrigger control: a task that Failed
// (or was cancelled) offers a "Retrigger" button beside the close ✕, and a task
// in any other state does not.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/log-modal.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
const page = await browser.newPage();

// ── A Failed task shows the Retrigger control, near the close button ──────────
await page.goto(`${BASE}/dev/log-modal?status=Failed`);
const retrigger = page.getByRole("button", { name: "Retrigger" });
await retrigger.waitFor({ state: "visible", timeout: 10_000 });
check("a Failed task shows a Retrigger button", await retrigger.isVisible());

const close = page.getByRole("button", { name: "Close" });
check("the close ✕ button is present", await close.isVisible());

// The control sits inside the modal header, immediately before the close ✕.
const order = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const r = btns.findIndex((b) => b.textContent?.includes("Retrigger"));
  const c = btns.findIndex((b) => b.getAttribute("aria-label") === "Close");
  return { r, c };
});
check(
  "Retrigger sits just before the close ✕ in the header",
  order.r >= 0 && order.c >= 0 && order.r < order.c,
);

// ── A running task offers no Retrigger control ───────────────────────────────
await page.goto(`${BASE}/dev/log-modal?status=Running`);
await page
  .getByRole("button", { name: "Close" })
  .waitFor({ state: "visible", timeout: 10_000 });
check(
  "a Running task shows no Retrigger button",
  (await page.getByRole("button", { name: "Retrigger" }).count()) === 0,
);

await finish(browser);
