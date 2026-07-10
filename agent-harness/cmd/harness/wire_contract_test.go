package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// wireContract mirrors the constants that cross the TS↔Go process boundary and
// so can't share a package. Its single source of truth is wire-contract.json at
// the repo root; the TypeScript suite (src/lib/wire-contract.test.ts) asserts
// its own constants against the same file. Asserting the harness constants here
// means any drift — a renamed marker, a reordered effort list — breaks CI
// instead of silently mismatching in production.
type wireContract struct {
	TokenMarkerPrefix      string   `json:"tokenMarkerPrefix"`
	AwaitInputMarker       string   `json:"awaitInputMarker"`
	ResumeMarker           string   `json:"resumeMarker"`
	EndSessionSentinel     string   `json:"endSessionSentinel"`
	EffortLevels           []string `json:"effortLevels"`
	HighestEffort          string   `json:"highestEffort"`
	HarnessContractVersion int      `json:"harnessContractVersion"`
}

func loadWireContract(t *testing.T) wireContract {
	t.Helper()
	path := filepath.Join("..", "..", "..", "wire-contract.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var c wireContract
	if err := json.Unmarshal(data, &c); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return c
}

func TestWireContractMarkers(t *testing.T) {
	c := loadWireContract(t)
	if tokenMarkerPrefix != c.TokenMarkerPrefix {
		t.Errorf("tokenMarkerPrefix = %q, contract = %q", tokenMarkerPrefix, c.TokenMarkerPrefix)
	}
	if awaitInputMarker != c.AwaitInputMarker {
		t.Errorf("awaitInputMarker = %q, contract = %q", awaitInputMarker, c.AwaitInputMarker)
	}
	if resumeMarker != c.ResumeMarker {
		t.Errorf("resumeMarker = %q, contract = %q", resumeMarker, c.ResumeMarker)
	}
	if endSessionSentinel != c.EndSessionSentinel {
		t.Errorf("endSessionSentinel = %q, contract = %q", endSessionSentinel, c.EndSessionSentinel)
	}
	if harnessContractVersion != c.HarnessContractVersion {
		t.Errorf("harnessContractVersion = %d, contract = %d", harnessContractVersion, c.HarnessContractVersion)
	}
}

func TestWireContractEffortLevels(t *testing.T) {
	c := loadWireContract(t)

	// The harness allow-list is a set; the contract lists it lowest-to-highest.
	// Compare as sorted sets so the test doesn't wrongly couple to ordering.
	got := make([]string, 0, len(effortLevels))
	for level := range effortLevels {
		got = append(got, level)
	}
	sort.Strings(got)
	want := append([]string(nil), c.EffortLevels...)
	sort.Strings(want)

	if !reflect.DeepEqual(got, want) {
		t.Errorf("effortLevels = %v, contract = %v", got, want)
	}

	// Every contract level must normalize to itself (the CLI accepts it).
	for _, level := range c.EffortLevels {
		if normalizeEffort(level) != level {
			t.Errorf("normalizeEffort(%q) = %q, want %q", level, normalizeEffort(level), level)
		}
	}

	// The ultracode gate (config.highestEffort) must equal the contract's
	// declared highest level, and that level must be the last (top) contract
	// entry and a valid member. This is what binds ultracode to the true top of
	// the ladder across the process boundary: adding a new highest level without
	// updating highestEffort — leaving ultracode on the old second-highest —
	// breaks CI here.
	if highestEffort != c.HighestEffort {
		t.Errorf("highestEffort = %q, contract = %q", highestEffort, c.HighestEffort)
	}
	if !effortLevels[c.HighestEffort] {
		t.Errorf("contract highestEffort %q is not a known effort level", c.HighestEffort)
	}
	if last := c.EffortLevels[len(c.EffortLevels)-1]; last != c.HighestEffort {
		t.Errorf("contract highestEffort = %q, but last effortLevels entry = %q", c.HighestEffort, last)
	}
}
