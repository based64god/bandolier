// Browser smoke test for the interactive session reveal scroll. When a running
// session starts awaiting input the row scrolls itself to the top of the
// viewport; its expanded body must then fill the rest of the screen so the
// interactive controls (collapse / end session / terminate) sit at the top and
// the composer at the bottom — on tall and short viewports alike.
//
// The old fixed 85vh body couldn't manage both: on tall screens it left the
// composer floating well short of the bottom, and on short ones the row plus an
// 85vh body overran the viewport and clipped the composer off the bottom. The
// body is now sized to fill from just under the row to the bottom edge
// (calc(100dvh - rowHeight)). A second bug compounded it: focusing the composer
// scrolled the textarea into view from the bottom, dragging the row up off the
// top ("scrolls too far") — fixed by focusing with preventScroll so the row's
// reveal owns the scroll.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/interactive-scroll.spec.mjs
import { BASE, check, launch, finish } from "./helpers.mjs";

const browser = await launch();

// A spread of supported sizes: desktop, small laptop, tablet portrait, phone
// portrait, and a short landscape phone (the worst case for the row-plus-body
// fit, where the old 85vh body clipped the composer off the bottom).
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "laptop-short", width: 1366, height: 620 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "phone-portrait", width: 390, height: 740 },
  { name: "landscape-short", width: 780, height: 380 },
];

// The reveal uses smooth scroll (and the awaiting transition also snaps the
// transcript and focuses the composer). Poll window.scrollY until it stops
// moving so measurements come from the settled position.
async function settleScroll(page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const y = await page.evaluate(() => window.scrollY);
    if (y === last) return;
    last = y;
    await page.waitForTimeout(75);
  }
}

// The composer is the bordered input bar wrapping the textarea; walk up from the
// textarea to it so we can measure the whole control, padding included.
function composerBottom(page) {
  return page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return null;
    let el = ta.parentElement;
    while (el && !el.className.includes("border-t")) el = el.parentElement;
    return (el ?? ta).getBoundingClientRect().bottom;
  });
}

// Assert the revealed session pins its interactive row to the top of the
// viewport and its composer to the bottom (visible, not clipped, not floating
// short of it).
async function checkRevealed(page, row, label, height) {
  const rowTop = (await row.boundingBox()).y;
  const bottom = await composerBottom(page);
  check(
    `${label}: interactive row is at the top (top=${rowTop.toFixed(0)})`,
    Math.abs(rowTop) <= 3,
  );
  check(
    `${label}: composer is fully visible (bottom=${bottom?.toFixed(0)}, vh=${height})`,
    bottom !== null && bottom <= height + 2,
  );
  check(
    `${label}: composer sits at the bottom (bottom=${bottom?.toFixed(0)}, vh=${height})`,
    bottom !== null && bottom >= height - 24,
  );
}

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
  });
  await page.goto(`${BASE}/dev/interactive-scroll`);

  // The collapsed interactive row is the first row in the table body; the
  // expanded body is the second. Reveal fires on the awaiting transition.
  const row = page.locator("[data-testid='rows'] > tr").first();
  await row.waitFor({ state: "visible", timeout: 5000 });

  await page.getByTestId("await").click();
  await settleScroll(page);

  await checkRevealed(
    page,
    row,
    `${vp.name} (${vp.width}x${vp.height})`,
    vp.height,
  );

  await page.close();
}

// A session the user had collapsed that then starts awaiting: this path fires
// the reveal before the body has mounted, then again once it has. It must still
// settle with the row at the top and the composer at the bottom.
{
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.goto(`${BASE}/dev/interactive-scroll`);
  const rows = page.locator("[data-testid='rows'] > tr");
  const row = rows.first();
  await row.waitFor({ state: "visible", timeout: 5000 });

  // Collapse the running session (it mounts expanded) by clicking its name.
  await page.getByText("an interactive session").click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid='rows'] > tr").length === 1,
    { timeout: 5000 },
  );
  check("collapsed session hides its body", (await rows.count()) === 1);

  // Now it starts awaiting — expand + reveal from the collapsed state.
  await page.getByTestId("await").click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-testid='rows'] > tr").length === 2,
    { timeout: 5000 },
  );
  await settleScroll(page);
  await checkRevealed(page, row, "collapsed->awaiting (1280x800)", 800);

  await page.close();
}

await finish(browser);
