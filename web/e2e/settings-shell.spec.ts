// Smoke test for the shared SettingsShell chrome on narrow (mobile) viewports.
// Both the sticky header (title + repo accessory + back link) and the group-tab
// row must stay within the viewport instead of pushing the page wider than it —
// a long repo name in the header, or many tabs, must not cause horizontal
// page overflow.
import { BASE, check, finish, launch } from "./helpers.ts";

const browser = await launch();

async function measure(width: number) {
  const page = await browser.newPage({ viewport: { width, height: 812 } });
  await page.goto(`${BASE}/dev/settings-shell`, { waitUntil: "networkidle" });
  await page.waitForSelector("nav");
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const nav = document.querySelector("nav");
    const header = document.querySelector("header");
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      navRight: nav!.getBoundingClientRect().right,
      headerScrollWidth: header!.scrollWidth,
      headerClientWidth: header!.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
  await page.close();
  return m;
}

for (const width of [375, 320]) {
  const m = await measure(width);
  console.log(`  [${width}px]`, JSON.stringify(m));
  check(
    `[${width}px] page does not overflow horizontally`,
    m.docScrollWidth <= m.docClientWidth,
  );
  check(
    `[${width}px] header does not overflow`,
    m.headerScrollWidth <= m.headerClientWidth,
  );
  check(
    `[${width}px] nav stays within the viewport`,
    m.navRight <= m.innerWidth + 1,
  );
}

await finish(browser);
