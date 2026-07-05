// Browser smoke test for the Conversation transcript's awaiting re-pin: when a
// session starts awaiting input the parent bumps `scrollSignal`, and the
// transcript must snap back to the bottom (re-pinning stick-to-bottom) even if
// the user had scrolled up to read earlier output. Playwright isn't a project
// dependency (it's installed globally in this environment), so resolve it from
// the local node_modules if present, else fall back to the global install.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/conversation.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.CONVERSATION_BASE_URL ?? "http://localhost:3137";
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

await page.goto(`${BASE}/dev/conversation`);

// The scroll container is the transcript div (overflow-auto) inside the harness.
const scroller = page.locator(".overflow-auto").first();
await scroller.waitFor({ state: "visible", timeout: 5000 });

const distanceFromBottom = () =>
  scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

// The tall transcript starts pinned to the bottom on mount.
check("starts pinned to the bottom", (await distanceFromBottom()) < 40);

// Scroll up to read earlier output — the view is no longer at the bottom.
await scroller.evaluate((el) => {
  el.scrollTop = 0;
});
check("scrolls up away from the bottom", (await distanceFromBottom()) > 40);

// The generic "Scroll to bottom" affordance appears once unpinned.
check(
  "'Scroll to bottom' button shows when scrolled up",
  (await page.getByRole("button", { name: "Scroll to bottom" }).count()) === 1,
);

// Simulate the awaiting-input transition (parent bumps scrollSignal): the view
// snaps back to the bottom.
await page.getByTestId("await").click();
await page.waitForTimeout(200);
check(
  "awaiting transition re-pins to the bottom",
  (await distanceFromBottom()) < 40,
);
check(
  "'Scroll to bottom' button hides once re-pinned",
  (await page.getByRole("button", { name: "Scroll to bottom" }).count()) === 0,
);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
