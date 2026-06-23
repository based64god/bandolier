// Browser smoke test for the slash-command composer. Playwright isn't a project
// dependency (it's installed globally in this environment), so resolve it from
// the local node_modules if present, else fall back to the global install.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/composer.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.COMPOSER_BASE_URL ?? "http://localhost:3137";
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

// ── Scenario 1: live commands advertised via ?commands= ──────────────────────
await page.goto(
  `${BASE}/dev/composer?commands=code-review,clear,compact,verify`,
);
const ta = page.locator("textarea");
await ta.click();

// Typing "/" opens the menu with all advertised commands.
await ta.type("/");
const menu = page.getByRole("listbox", { name: "Slash commands" });
await menu.waitFor({ state: "visible", timeout: 5000 });
const allOpts = await page.getByRole("option").count();
check("menu opens on '/' with all 4 advertised commands", allOpts === 4);

// Filtering by prefix.
await ta.type("co");
const filtered = await page.getByRole("option").allInnerTexts();
check(
  "prefix 'co' filters to code-review + compact",
  filtered.length === 2 &&
    filtered.join(" ").includes("/code-review") &&
    filtered.join(" ").includes("/compact"),
);

// ArrowDown then Enter selects the second match (compact) → draft becomes "/compact ".
await ta.press("ArrowDown");
await ta.press("Enter");
const afterSelect = await ta.inputValue();
check("ArrowDown+Enter inserts '/compact '", afterSelect === "/compact ");

// Menu closed after selection (trailing space starts args).
check("menu closes after selection", !(await menu.isVisible()));

// Enter now sends the message.
await ta.press("Enter");
const sent1 = await page.getByTestId("sent-item").allInnerTexts();
check(
  "Enter sends '/compact'",
  sent1.length === 1 && sent1[0].trim() === "/compact",
);

// ── Scenario 2: Escape keeps text, drops the slash ───────────────────────────
await ta.type("/ver");
await menu.waitFor({ state: "visible", timeout: 5000 });
await ta.press("Escape");
check("Escape closes the menu", !(await menu.isVisible()));
check(
  "Escape drops the leading slash, keeps text",
  (await ta.inputValue()) === "ver",
);

// ── Scenario 3: click selection + fallback defaults (no ?commands=) ───────────
await page.goto(`${BASE}/dev/composer`);
const ta2 = page.locator("textarea");
await ta2.click();
await ta2.type("/");
const menu2 = page.getByRole("listbox", { name: "Slash commands" });
await menu2.waitFor({ state: "visible", timeout: 5000 });
const defaultCount = await page.getByRole("option").count();
check("falls back to curated defaults when none advertised", defaultCount >= 8);

// Click the "/init" option.
await page.getByRole("option").filter({ hasText: "/init" }).first().click();
check(
  "click selection inserts '/init '",
  (await ta2.inputValue()) === "/init ",
);

// ── Scenario 4: arrow-key navigation scrolls the highlight into view ──────────
// With more commands than fit in max-h-60, paging down with ArrowDown must
// keep the highlighted option scrolled into view rather than off the fold.
const many = Array.from(
  { length: 30 },
  (_, i) => `cmd${String(i).padStart(2, "0")}`,
);
await page.goto(`${BASE}/dev/composer?commands=${many.join(",")}`);
const ta3 = page.locator("textarea");
await ta3.click();
await ta3.type("/");
const menu3 = page.getByRole("listbox", { name: "Slash commands" });
await menu3.waitFor({ state: "visible", timeout: 5000 });

const scrollTopStart = await menu3.evaluate((el) => el.scrollTop);
for (let i = 0; i < 25; i++) await ta3.press("ArrowDown");
const scrollTopDown = await menu3.evaluate((el) => el.scrollTop);
const highlightVisible = await menu3.evaluate((el) => {
  const opt = el.querySelector('[data-nav="25"]');
  if (!opt) return false;
  const c = el.getBoundingClientRect();
  const o = opt.getBoundingClientRect();
  return o.top >= c.top - 1 && o.bottom <= c.bottom + 1;
});
check(
  "ArrowDown scrolls the list past the fold",
  scrollTopDown > scrollTopStart,
);
check("highlighted option stays in view while navigating", highlightVisible);

for (let i = 0; i < 25; i++) await ta3.press("ArrowUp");
const scrollTopUp = await menu3.evaluate((el) => el.scrollTop);
check("ArrowUp scrolls back toward the top", scrollTopUp < scrollTopDown);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
