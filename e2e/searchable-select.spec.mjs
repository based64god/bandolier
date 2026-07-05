// Browser smoke test for SearchableSelect arrow-key navigation.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/searchable-select.spec.mjs
import { BASE, check, launch, finish } from "./helpers.mjs";

const browser = await launch();
const page = await browser.newPage();
const value = () => page.getByTestId("value").innerText();

await page.goto(`${BASE}/dev/searchable-select`);
const trigger = page.getByRole("button").first();

// ── Open with the keyboard from the closed trigger ───────────────────────────
await trigger.focus();
await trigger.press("ArrowDown");
const search = page.getByPlaceholder("Search…");
await search.waitFor({ state: "visible", timeout: 5000 });
check("ArrowDown on closed trigger opens the panel", await search.isVisible());

// Initial value is "beta"; the highlight should start on the selected row, so
// ArrowDown lands on "gamma" (beta+1).
await search.press("ArrowDown");
await search.press("Enter");
check("ArrowDown from selection + Enter picks 'gamma'", (await value()) === "gamma");

// ── ArrowUp wraps / walks backward ───────────────────────────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
// Highlight starts on "gamma" (index 3 incl. None row). ArrowUp → "beta".
await search.press("ArrowUp");
await search.press("Enter");
check("ArrowUp from selection + Enter picks 'beta'", (await value()) === "beta");

// ── End jumps to the last row, Enter selects it ──────────────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
await search.press("End");
await search.press("Enter");
check("End + Enter picks last option 'epsilon'", (await value()) === "epsilon");

// ── Home jumps to the first row (the "None" clear row) ───────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
await search.press("Home");
await search.press("Enter");
check("Home + Enter picks the clear/None row", (await value()) === "null");

// ── ArrowUp from the top wraps to the bottom ─────────────────────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
// value is null → highlight starts at 0 (None). ArrowUp wraps to last (epsilon).
await search.press("ArrowUp");
await search.press("Enter");
check("ArrowUp from first row wraps to last 'epsilon'", (await value()) === "epsilon");

// ── Typing filters, then arrow nav walks the filtered list ───────────────────
await trigger.press("Enter");
await search.waitFor({ state: "visible", timeout: 5000 });
await search.type("a");
// Filtered: alpha, gamma, delta. Highlight reset to 0 → alpha. Enter picks it.
await search.press("Enter");
check("typing 'a' + Enter picks first match 'alpha'", (await value()) === "alpha");

// ── Recent group (second harness instance) ───────────────────────────────────
// recentValues is ["gamma", "alpha", "zeta-unknown"], so the open panel is:
//   Recent: gamma(0), alpha(1)   All: alpha(2), beta(3), gamma(4), delta(5), epsilon(6)
const recentValue = () => page.getByTestId("recent-value").innerText();
const recentTrigger = page.getByRole("button").nth(1);
const recentSearch = page.getByPlaceholder("Search recents…");

await recentTrigger.focus();
await recentTrigger.press("ArrowDown");
await recentSearch.waitFor({ state: "visible", timeout: 5000 });
const panel = page.locator("body > div").filter({ has: recentSearch });
check(
  "Recent and All headings render",
  (await panel.getByText("Recent", { exact: true }).isVisible()) &&
    (await panel.getByText("All", { exact: true }).isVisible()),
);
check(
  "recent value without a matching option is ignored",
  (await panel.getByText("zeta").count()) === 0,
);
// No selection yet → highlight starts on the first recent row.
await recentSearch.press("Enter");
check("Enter on open picks first recent 'gamma'", (await recentValue()) === "gamma");

// Reopen: gamma is in the recent group, so the highlight starts there and
// ArrowDown walks to the next recent row.
await recentTrigger.press("Enter");
await recentSearch.waitFor({ state: "visible", timeout: 5000 });
await recentSearch.press("ArrowDown");
await recentSearch.press("Enter");
check("ArrowDown from recent 'gamma' picks recent 'alpha'", (await recentValue()) === "alpha");

// Reopen: highlight starts on recent alpha(1); two ArrowDowns cross the section
// boundary into the full list (alpha(2) → beta(3)).
await recentTrigger.press("Enter");
await recentSearch.waitFor({ state: "visible", timeout: 5000 });
await recentSearch.press("ArrowDown");
await recentSearch.press("ArrowDown");
await recentSearch.press("Enter");
check("nav runs continuously across sections, picks 'beta'", (await recentValue()) === "beta");

// Searching collapses to a single flat list — no Recent heading, and the first
// match is from the full list order (alpha).
await recentTrigger.press("Enter");
await recentSearch.waitFor({ state: "visible", timeout: 5000 });
await recentSearch.type("a");
check(
  "searching hides the Recent group",
  (await panel.getByText("Recent", { exact: true }).count()) === 0,
);
await recentSearch.press("Enter");
check("search + Enter picks first match 'alpha'", (await recentValue()) === "alpha");

await finish(browser);
