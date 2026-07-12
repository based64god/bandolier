// Browser smoke test for the EffortPicker dropdown + Preferred toggle.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/effort-picker.spec.ts
import { BASE, check, launch, finish } from "./helpers.ts";

const browser = await launch();
const page = await browser.newPage();
const value = () => page.getByTestId("value").innerText();
const preferred = () => page.getByTestId("preferred").innerText();

await page.goto(`${BASE}/dev/effort-picker`);

// The dropdown trigger is the picker's only closed-state button.
const trigger = page.getByRole("button").first();
// Pick a level by opening the dropdown and clicking its row (labelled with the
// human-facing name); returns once the panel has closed again.
async function pick(label: string) {
  await trigger.click();
  const search = page.getByPlaceholder("Search effort…");
  await search.waitFor({ state: "visible", timeout: 5000 });
  await page.getByRole("button", { name: label, exact: true }).click();
  await search.waitFor({ state: "hidden", timeout: 5000 });
}

// ── All five levels + default are selectable ────────────────────────────────
check("starts on the default level", (await value()) === "default");

for (const [label, level] of [
  ["Low", "low"],
  ["Medium", "medium"],
  ["High", "high"],
  ["Extra high", "xhigh"],
  ["Max — Ultracode", "max"],
] as const) {
  await pick(label);
  check(
    `selecting '${label}' resolves to '${level}'`,
    (await value()) === level,
  );
}

// ── Max surfaces ultracode ───────────────────────────────────────────────────
check(
  "helper text explains ultracode",
  (await page.getByText("turns on ultracode").count()) === 1,
);

// ── Preferred toggle pins the current level ──────────────────────────────────
await pick("High");
await page.getByRole("checkbox").check();
check("Preferred pins the selected level", (await preferred()) === "high");

// Switching level leaves the old pin until re-toggled (mirrors the modal).
await pick("Low");
check("changing level keeps the prior pin", (await preferred()) === "high");
await page.getByRole("checkbox").check();
check("re-checking re-pins to the new level", (await preferred()) === "low");

// ── Back to default clears the value, disabling the pin ──────────────────────
await pick("Default");
check("can return to default", (await value()) === "default");
check(
  "Preferred toggle disabled at default",
  await page.getByRole("checkbox").isDisabled(),
);

await finish(browser);
