import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EFFORT_LEVELS, HIGHEST_EFFORT } from "~/lib/effort";
import { HARNESS_CONTRACT_VERSION } from "~/lib/harness-contract";
import { TOKEN_MARKER } from "~/lib/tokens";

// Constants that cross the TS↔Go process boundary can't share a package, so
// wire-contract.json is their single source of truth. The Go harness asserts
// its own constants against the same file (agent-harness/cmd/harness/
// wire_contract_test.go); asserting both sides here means any drift — a renamed
// marker, a reordered effort list — breaks CI instead of silently mismatching
// in production.

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../wire-contract.json", import.meta.url)),
    "utf8",
  ),
) as {
  tokenMarkerPrefix: string;
  awaitInputMarker: string;
  resumeMarker: string;
  endSessionSentinel: string;
  effortLevels: string[];
  highestEffort: string;
  harnessContractVersion: number;
};

describe("wire contract", () => {
  it("pins the exact wire values (edit here only with a matching harness change)", () => {
    // These strings are the actual bytes on the wire; the Go harness emits or
    // matches each one. Freezing them here catches an accidental edit to the
    // fixture — which would otherwise let the two languages drift apart.
    expect(contract.tokenMarkerPrefix).toBe("BANDOLIER_TOKENS=");
    expect(contract.awaitInputMarker).toBe("BANDOLIER_AWAIT_INPUT");
    expect(contract.resumeMarker).toBe("BANDOLIER_RESUME");
    expect(contract.endSessionSentinel).toBe("__BANDOLIER_END_SESSION__");
    expect(contract.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("matches the token marker used by the ingest parser", () => {
    expect(TOKEN_MARKER).toBe(contract.tokenMarkerPrefix);
  });

  it("matches the effort allow-list surfaced to the dashboard/webhook", () => {
    expect([...EFFORT_LEVELS]).toEqual(contract.effortLevels);
  });

  it("pins the highest effort (the ultracode level) to the top of the ladder", () => {
    // HIGHEST_EFFORT drives the picker's ultracode label and, across the wire,
    // the harness's ultracode gate. Binding it to the last effort level and to
    // the contract keeps "ultracode == highest available effort" from drifting.
    expect(contract.highestEffort).toBe("max");
    expect(HIGHEST_EFFORT).toBe(contract.highestEffort);
    expect(EFFORT_LEVELS.at(-1)).toBe(contract.highestEffort);
  });

  it("matches the harness contract version the staleness warning compares against", () => {
    expect(HARNESS_CONTRACT_VERSION).toBe(contract.harnessContractVersion);
  });
});
