#!/usr/bin/env node
// Emits a shields.io endpoint JSON (schemaVersion 1) for the unit-test line
// coverage in coverage/coverage-summary.json (written by the json-summary
// reporter during `pnpm test:coverage`). CI publishes the output to the
// `badges` branch, which the README's coverage badge reads through
// img.shields.io/endpoint.
import { readFileSync } from "node:fs";

const summary = JSON.parse(
  readFileSync("coverage/coverage-summary.json", "utf8"),
);
const pct = summary.total.lines.pct;

const color =
  pct >= 90
    ? "brightgreen"
    : pct >= 80
      ? "green"
      : pct >= 70
        ? "yellowgreen"
        : pct >= 60
          ? "yellow"
          : "red";

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    label: "coverage",
    message: `${parseFloat(pct.toFixed(1))}%`,
    color,
  })}\n`,
);
