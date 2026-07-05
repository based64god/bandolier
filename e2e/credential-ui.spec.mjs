// Browser smoke test for the shared credential building blocks
// (SecretForm → MaskedCredentialRow → Remove, and ToggleSection).
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/credential-ui.spec.mjs
import { BASE, check, launch, finish } from "./helpers.mjs";

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${BASE}/dev/credential-ui`);

// Save button is disabled until the field has a value. Scoped to the secret
// form so it doesn't collide with the compute form's Save button below.
const save = page
  .locator("form", { has: page.getByPlaceholder("secret") })
  .getByRole("button", { name: "Save" });
check("save disabled when empty", await save.isDisabled());

await page.getByPlaceholder("secret").fill("sk-secret-123");
check("save enabled after typing", await save.isEnabled());

await save.click();

// The form is replaced by the masked row + success banner.
await page.getByTestId("masked").waitFor();
check(
  "masked row shows saved value",
  (await page.getByTestId("masked").innerText()) === "sk-secret-123",
);
check(
  "success banner shown",
  await page.getByText("Saved and verified ✓").isVisible(),
);

// Remove restores the form and reports the removal.
await page.getByRole("button", { name: "Remove" }).click();
await page.getByPlaceholder("secret").waitFor();
check(
  "removal reported",
  (await page.getByTestId("removed").innerText()) === "removed",
);

// Toggle flips on aria-checked and the echoed state.
const toggle = page.getByRole("switch", { name: "A toggle" });
check(
  "toggle starts off",
  (await toggle.getAttribute("aria-checked")) === "false",
);
await toggle.click();
check(
  "toggle turns on",
  (await toggle.getAttribute("aria-checked")) === "true",
);
check(
  "toggle state echoed",
  (await page.getByTestId("toggle").innerText()) === "on",
);

// ComputeForm: Save is disabled until an input is touched, then reports the
// entered CPU/memory to onSave.
const computeForm = page.locator("form", {
  has: page.getByPlaceholder("2Gi"),
});
const computeSave = computeForm.getByRole("button", { name: "Save" });
check("compute save disabled when untouched", await computeSave.isDisabled());
await computeForm.getByPlaceholder("2", { exact: true }).fill("4");
await computeForm.getByPlaceholder("2Gi").fill("8Gi");
check("compute save enabled after typing", await computeSave.isEnabled());
await computeSave.click();
check(
  "compute values reported",
  (await page.getByTestId("compute").innerText()) === "4/8Gi",
);

await finish(browser);
