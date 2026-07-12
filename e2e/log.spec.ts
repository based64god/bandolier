// Browser smoke test for the log modal's HarnessSegment: a run of tool calls
// collapses behind a summary, and each call's captured stdout/stderr hides
// behind its own nested "output" expander so a long result doesn't flood the
// fold.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/log.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${BASE}/dev/log`);

const withOutput = page.getByTestId("with-output");
const summary = withOutput.getByText(/tool calls?$/);
const outputText = page.getByText("nothing to commit, working tree clean");
const outputExpander = withOutput.getByText("output", { exact: true }).first();

// ── Summary counts tool calls, not the folded output lines ───────────────────
check(
  "summary counts the two tool calls (output lines excluded)",
  (await summary.innerText()).includes("2 tool calls"),
);

// ── Output stays folded until its own expander is opened ─────────────────────
check(
  "tool output is hidden while the segment is collapsed",
  !(await outputText.isVisible()),
);

await summary.click();
check(
  "expanding the segment reveals the tool-call lines",
  await withOutput.getByText("→ Bash: git status").isVisible(),
);
check(
  "each captured result gets its own nested output expander",
  (await withOutput.getByText("output", { exact: true }).count()) === 2,
);
check(
  "output is still folded behind its nested expander",
  !(await outputText.isVisible()),
);

await outputExpander.click();
check(
  "opening the nested expander reveals the captured stdout",
  await outputText.isVisible(),
);

// ── A call with no captured output gets no expander ──────────────────────────
const noOutput = page.getByTestId("no-output");
await noOutput.getByText(/tool calls?$/).click();
check(
  "a resultless call shows no output expander",
  (await noOutput.getByText("output", { exact: true }).count()) === 0,
);

await finish(browser);
