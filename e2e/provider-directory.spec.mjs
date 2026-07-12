// Browser smoke test for the ProviderDirectory accordion's credential "shape
// hint": the concise subtitle shown under a provider's label in the collapsed
// row (e.g. "Access key + secret + region"). Proves the hint renders in the row
// itself — visible before the card is expanded — and that a provider without a
// hint shows only its label.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/provider-directory.spec.mjs
import { BASE, check, launch, finish } from "./helpers.mjs";

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${BASE}/dev/provider-directory`);

const anthropicRow = page.getByRole("button", { name: /Anthropic/ });
const bedrockRow = page.getByRole("button", { name: /AWS Bedrock/ });
const plainRow = page.getByRole("button", { name: /No-hint provider/ });

// ── Hints render in the collapsed row (nothing is expanded yet) ──────────────
check(
  "no card body is mounted before expanding",
  (await page.getByTestId("anthropic-body").count()) === 0,
);
check(
  "Anthropic hint shows in the collapsed row",
  (await anthropicRow.innerText()).includes(
    "API key (sk-ant-…) or Claude subscription",
  ),
);
check(
  "Bedrock hint shows in the collapsed row even when unconfigured",
  (await bedrockRow.innerText()).includes("Access key + secret + region"),
);

// ── A provider without a hint shows only its label ───────────────────────────
const plainText = (await plainRow.innerText()).replace(/[›\s]/g, "");
check(
  "provider without a hint renders no subtitle",
  plainText === "No-hintprovider",
);

// ── The hint lives in the row, not the body: expanding reveals the body while
//    the hint stays put ──────────────────────────────────────────────────────
await anthropicRow.click();
check(
  "expanding the card mounts its body",
  await page.getByTestId("anthropic-body").isVisible(),
);
check(
  "hint remains visible while the card is expanded",
  (await anthropicRow.innerText()).includes(
    "API key (sk-ant-…) or Claude subscription",
  ),
);

await finish(browser);
