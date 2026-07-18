// Browser smoke test for the footer's credential-usage indicators: the strip
// renders one badge per recently-used provider (first-class and gollm-proxied),
// each with a relative "used …" timestamp, and renders nothing when there's no
// recent usage.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/credential-usage.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${BASE}/dev/credential-usage`);

const strip = page.getByTestId("credential-usage").first();
check("the recently-used strip renders", await strip.isVisible());
check(
  "the strip is labelled 'Recently used'",
  (await strip.innerText()).includes("Recently used"),
);

// ── First-class provider badge ───────────────────────────────────────────────
const anthropic = page.getByTestId("credential-usage-anthropic");
check("a first-class provider badge renders", await anthropic.isVisible());
check(
  "the first-class badge shows its own label",
  (await anthropic.innerText()).includes("Anthropic"),
);
check(
  "the first-class badge shows a relative timestamp",
  (await anthropic.innerText()).includes("3m ago"),
);

// ── gollm-proxied provider badge (catalog label passthrough) ─────────────────
const groq = page.getByTestId("credential-usage-gollm:groq");
check("a gollm-proxied provider badge renders", await groq.isVisible());
check(
  "the gollm badge uses the catalog label",
  (await groq.innerText()).includes("Groq"),
);
check(
  "the gollm badge shows an hours-ago timestamp",
  (await groq.innerText()).includes("2h ago"),
);

// ── Day-scale timestamp ──────────────────────────────────────────────────────
const openai = page.getByTestId("credential-usage-openai");
check(
  "an older use reads in days",
  (await openai.innerText()).includes("3d ago"),
);

// ── Empty state renders nothing ──────────────────────────────────────────────
const emptyWrapper = page.getByTestId("empty-wrapper");
check(
  "the empty state renders no strip",
  (await emptyWrapper.getByTestId("credential-usage").count()) === 0,
);

await finish(browser);
