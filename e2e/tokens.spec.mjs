// Browser smoke test for the TokenReadout cost tooltip: a priced model surfaces
// an estimated cost line in the hover title (derived from input/output/cache),
// while an unpriced model shows the token breakdown with no cost line.
// Playwright is installed globally in this environment; resolve it locally
// first, else fall back to the global install.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/tokens.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.TOKENS_BASE_URL ?? "http://localhost:3137";
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
const title = (testid) =>
  page.getByTestId(testid).locator("[title]").getAttribute("title");

await page.goto(`${BASE}/dev/tokens`);

// ── Priced model: tooltip carries an estimated cost derived from usage ───────
// 1.2M in, 450K out, 80K cache-read, 20K cache-write on Opus 4.8 ($5/$25/MTok,
// cache read 0.1×, cache write 1.25×):
//   1.2*5 + 0.45*25 + 0.08*0.5 + 0.02*6.25 = 6 + 11.25 + 0.04 + 0.125 = 17.415,
// which formats (toFixed(2)) to "$17.41".
const opusTitle = await title("readout-opus");
check("priced readout shows a cost line", opusTitle.includes("est. cost"));
check("priced readout computes the expected total", opusTitle.includes("$17.41"));
check(
  "priced readout still shows the token breakdown",
  opusTitle.includes("input") && opusTitle.includes("cache write"),
);

// ── Bedrock inference-profile id resolves to the same Claude family ──────────
const haikuTitle = await title("readout-haiku");
check(
  "bedrock-prefixed model is still priced",
  haikuTitle.includes("est. cost"),
);

// ── Unknown model: no cost line, breakdown intact ────────────────────────────
const unknownTitle = await title("readout-unknown");
check(
  "unpriced model shows no cost line",
  !unknownTitle.includes("est. cost"),
);
check(
  "unpriced model still shows the token breakdown",
  unknownTitle.includes("input") && unknownTitle.includes("output"),
);

// ── No-model priced-less case (millions, no model) omits cost ────────────────
const millionsTitle = await title("readout-millions");
check(
  "readout without a model shows no cost line",
  !millionsTitle.includes("est. cost"),
);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
