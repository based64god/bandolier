// Browser smoke test for the TokenReadout chip: it stays absent when there's no
// usage (null / all-zero) and otherwise shows the abbreviated total behind the
// coins glyph, with the full per-category breakdown on its title/aria label.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/tokens.spec.mjs
import { BASE, check, launch, finish } from "./helpers.mjs";

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${BASE}/dev/tokens`);

const cell = (label) => page.getByTestId(`readout-${label}`);

// ── No-usage states render nothing ───────────────────────────────────────────
check(
  "null usage renders no chip",
  (await cell("null").innerText()).trim() === "" &&
    (await cell("null").locator("svg").count()) === 0,
);
check(
  "all-zero usage renders no chip",
  (await cell("zero").innerText()).trim() === "" &&
    (await cell("zero").locator("svg").count()) === 0,
);

// ── Small total renders verbatim (under 1K) ──────────────────────────────────
const small = cell("small");
check("small usage renders a chip", (await small.innerText()).includes("165"));
check(
  "small chip carries the coins glyph",
  (await small.locator("svg").count()) === 1,
);
check(
  "small chip labels the total for a11y",
  (await small.locator("[aria-label]").getAttribute("aria-label")) ===
    "165 tokens used",
);

// ── Thousands abbreviate to K ────────────────────────────────────────────────
const thousands = cell("thousands");
check(
  "thousands abbreviate (6.8K)",
  (await thousands.innerText()).includes("6.8K"),
);
check(
  "thousands title carries the full breakdown",
  await (async () => {
    const title = await thousands.locator("[title]").getAttribute("title");
    return (
      title.includes("6,800 tokens") &&
      title.includes("input 4,200") &&
      title.includes("output 1,800") &&
      title.includes("cache read 500") &&
      title.includes("cache write 300")
    );
  })(),
);

// ── Millions abbreviate to M ─────────────────────────────────────────────────
const millions = cell("millions");
check(
  "millions abbreviate (1.8M)",
  (await millions.innerText()).includes("1.8M"),
);
check(
  "millions label the exact total",
  (await millions.locator("[aria-label]").getAttribute("aria-label")) ===
    "1,750,000 tokens used",
);

await finish(browser);
