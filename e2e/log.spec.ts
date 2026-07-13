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

// ── Preamble (setup / system prompt / task) renders inline, not collapsed ─────
const preamble = page.getByTestId("preamble");
check(
  "preamble is visible without expanding anything",
  await preamble
    .getByText("You are Claude Code, running one-shot.")
    .isVisible(),
);
check(
  "preamble is not mislabeled as tool calls",
  (await preamble.getByText(/tool calls?$/).count()) === 0,
);

// ── A subagent-only run reports its calls, not "0 tool calls" ─────────────────
const subagentOnly = page.getByTestId("subagent-only");
check(
  "subagent-only run counts the subagent's call, not zero",
  (await subagentOnly.getByText(/tool calls?$/).innerText()).includes(
    "1 tool call",
  ),
);

await finish(browser);
