// Browser smoke test for the shared credential building blocks
// (SecretForm → MaskedCredentialRow → Remove, and ToggleSection).
// Playwright is installed globally in this environment; resolve it locally
// first, else fall back to the global install.
//
// Run against a dev server serving the harness route:
//   pnpm next dev --port 3137 &
//   node e2e/credential-ui.spec.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/usr/local/lib/node_modules/playwright/index.js"));
}

const BASE = process.env.CREDENTIAL_UI_BASE_URL ?? "http://localhost:3137";
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

await page.goto(`${BASE}/dev/credential-ui`);

// Save button is disabled until the field has a value.
const save = page.getByRole("button", { name: "Save" });
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

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
