// Shared scaffolding for the e2e/*.spec.ts browser smoke tests. Each spec is a
// standalone Playwright script; this module owns the boilerplate they all share:
// resolving Playwright (installed globally in this environment, with a local
// node_modules fallback), launching Chromium, tallying check() results, and
// exiting non-zero when any assertion fails.
//
// Every spec drives the same origin, configured by E2E_BASE_URL (default the
// local dev server); e2e/run.ts points it at the server it boots.
import { createRequire } from "node:module";

import type * as Playwright from "playwright";
import type { Browser, BrowserType } from "playwright";

const require = createRequire(import.meta.url);
let chromium: BrowserType;
try {
  ({ chromium } = require("playwright") as typeof Playwright);
} catch {
  ({ chromium } = require(
    "/usr/local/lib/node_modules/playwright/index.js",
  ) as typeof Playwright);
}

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3137";

let passed = 0;
let failed = 0;

export function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

export function launch(): Promise<Browser> {
  return chromium.launch();
}

export async function finish(browser: Browser): Promise<never> {
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
