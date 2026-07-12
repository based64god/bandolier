// Browser smoke test for the Conversation transcript's awaiting re-pin: when a
// session starts awaiting input the parent bumps `scrollSignal`, and the
// transcript must snap back to the bottom (re-pinning stick-to-bottom) even if
// the user had scrolled up to read earlier output.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/conversation.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
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

// The generic "Scroll to bottom" affordance appears once unpinned. It renders
// only after React handles the scroll event, so wait for it instead of
// counting immediately.
const scrollToBottomShown = await page
  .getByRole("button", { name: "Scroll to bottom" })
  .waitFor({ state: "visible", timeout: 5000 })
  .then(() => true)
  .catch(() => false);
check("'Scroll to bottom' button shows when scrolled up", scrollToBottomShown);

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

await finish(browser);
