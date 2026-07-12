#!/usr/bin/env node
// Renders a shields.io endpoint JSON (schemaVersion 1) for a coverage
// percentage, so every coverage badge in the README (web app, agent harness,
// gollm proxy) shares one color scale and message format. CI publishes each
// rendered file to the `badges` branch, which the badges read through
// img.shields.io/endpoint.
//
// Importable (coverageBadge) so scripts/coverage-badge.mjs reuses the same
// color truth, and runnable as a CLI for the numbers CI computes on the fly:
//   node scripts/badge.mjs "gollm proxy" 81.6

export function coverageColor(pct) {
  if (pct >= 90) return "brightgreen";
  if (pct >= 80) return "green";
  if (pct >= 70) return "yellowgreen";
  if (pct >= 60) return "yellow";
  return "red";
}

export function coverageBadge(label, pct) {
  return {
    schemaVersion: 1,
    label,
    message: `${parseFloat(pct.toFixed(1))}%`,
    color: coverageColor(pct),
  };
}

// Run as a CLI only when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , label, pctArg] = process.argv;
  const pct = Number.parseFloat(pctArg);
  if (!label || Number.isNaN(pct)) {
    process.stderr.write("usage: badge.mjs <label> <pct>\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(coverageBadge(label, pct))}\n`);
}
