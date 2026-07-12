#!/usr/bin/env node
// Emits a shields.io endpoint JSON (schemaVersion 1) for the web app's
// unit-test line coverage in coverage/coverage-summary.json (written by the
// json-summary reporter during `pnpm test:coverage`). CI publishes the output
// to the `badges` branch, which the README's coverage badge reads through
// img.shields.io/endpoint. The color scale and message format are shared with
// the agent-harness and gollm-proxy Go coverage badges via scripts/badge.mjs.
import { readFileSync } from "node:fs";

import { coverageBadge } from "./badge.mjs";

const summary = JSON.parse(
  readFileSync("coverage/coverage-summary.json", "utf8"),
);

process.stdout.write(
  `${JSON.stringify(coverageBadge("coverage", summary.total.lines.pct))}\n`,
);
