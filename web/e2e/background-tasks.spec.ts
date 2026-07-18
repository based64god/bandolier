// Browser smoke test for the BackgroundTasksPanel: the pinned indicator reports
// the live background-task count (previewing a spawn label when a task id
// correlates to a subagent spawn), opens a popout listing every task, and prunes
// itself once the set has drained.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/background-tasks.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${BASE}/dev/background-tasks`);

const running = page.getByTestId("panel-running");
await running.waitFor({ state: "visible", timeout: 5000 });

// The pill reports the live count and, since the correlatable task is last,
// previews its subagent spawn's label.
check(
  "running panel shows the task count",
  await running
    .getByText("3 tasks running in the background")
    .first()
    .isVisible(),
);
check(
  "running panel previews the correlated label",
  await running.getByText("Agent(Explore): map the routes").first().isVisible(),
);

// The single-task scenario uses the singular noun.
check(
  "single-task panel uses the singular",
  await page
    .getByTestId("panel-one")
    .getByText("1 task running in the background")
    .first()
    .isVisible(),
);

// The drained scenario renders nothing (the panel returns null): no pill button.
check(
  "drained panel renders no indicator",
  (await page.getByTestId("panel-empty").getByRole("button").count()) === 0,
);

// A finished (non-running) session suppresses the indicator even with a stale,
// never-drained set — an abnormally-ended session must not show phantom work.
check(
  "finished-session panel suppresses the indicator",
  (await page.getByTestId("panel-not-running").getByRole("button").count()) ===
    0,
);

// Opening the popout lists every task — the labelled one and the generic fallbacks.
await running.getByRole("button").first().click();
const dialog = page.getByRole("dialog");
await dialog.waitFor({ state: "visible", timeout: 5000 });
check(
  "modal lists the correlated task by label",
  await dialog.getByText("Agent(Explore): map the routes").first().isVisible(),
);
check(
  "modal lists an uncorrelated task by a generic name",
  await dialog.getByText("Background task 1").first().isVisible(),
);

await finish(browser);
