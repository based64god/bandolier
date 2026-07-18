// Browser smoke test for the footer's credential-usage indicators: the strip
// renders one badge per recently-used provider. Metered API keys show a
// relative "used …" timestamp; subscriptions instead show a "how close to maxed
// out" meter with its percentage and a "Subscription" tag. The strip renders
// nothing when there's no recent usage.
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

// ── Subscription badge: a "how close to maxed out" meter ─────────────────────
const anthropic = page.getByTestId("credential-usage-anthropic");
check("a subscription badge renders", await anthropic.isVisible());
check(
  "the subscription badge is tagged Subscription",
  (await anthropic.innerText()).includes("Subscription"),
);
check(
  "the subscription badge shows its usage percentage (20 of 25 runs)",
  (await anthropic.innerText()).includes("80%"),
);
check(
  "the subscription badge renders a meter, not a timestamp",
  (await page.getByTestId("credential-meter-anthropic").count()) === 1 &&
    !(await anthropic.innerText()).includes("ago"),
);
check(
  "the reset time is surfaced in the badge tooltip",
  ((await anthropic.getAttribute("title")) ?? "").includes("resets in 40m"),
);

// A second, comfortably-under-budget subscription reads a lower percentage.
const openai = page.getByTestId("credential-usage-openai");
check(
  "a second subscription reads its own lower percentage (8 of 25)",
  (await openai.innerText()).includes("32%"),
);

// ── Metered API key: a relative "used …" timestamp, no meter ─────────────────
const groq = page.getByTestId("credential-usage-gollm:groq");
check("a metered gollm-proxied badge renders", await groq.isVisible());
check(
  "the gollm badge uses the catalog label",
  (await groq.innerText()).includes("Groq"),
);
check(
  "the metered badge shows a relative timestamp, not a meter",
  (await groq.innerText()).includes("2h ago") &&
    (await page.getByTestId("credential-meter-gollm:groq").count()) === 0,
);

// ── Day-scale timestamp ──────────────────────────────────────────────────────
const bedrock = page.getByTestId("credential-usage-bedrock");
check(
  "an older metered use reads in days",
  (await bedrock.innerText()).includes("3d ago"),
);

// ── Empty state renders nothing ──────────────────────────────────────────────
const emptyWrapper = page.getByTestId("empty-wrapper");
check(
  "the empty state renders no strip",
  (await emptyWrapper.getByTestId("credential-usage").count()) === 0,
);

await finish(browser);
