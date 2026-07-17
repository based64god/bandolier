// The server↔harness contract version, shared by the ingest path, the webhooks
// router, and the repo-config UI. The Go harness reports its own copy of this
// number on the ingest callback (X-Bandolier-Harness-Contract); comparing the
// last-reported version against this constant tells a repo admin their custom
// agent image was built from harness source too old for what the server now
// sends it (e.g. an image predating resumable runs silently ignores
// RESUME_BRANCH and crashes rewriting authorship against a ref it never
// fetched).

// This crosses the process boundary (the Go harness reports it, the server
// compares against it), so its value is pinned in wire-contract.json and
// asserted by both test suites — see src/lib/wire-contract.test.ts.
export const HARNESS_CONTRACT_VERSION = 2;

/**
 * The version persisted for a run whose ingest callback carried no
 * X-Bandolier-Harness-Contract header: a harness built before version
 * reporting existed. Distinct from null on the run row, which means the
 * callback never arrived at all (run still in flight, or predates this
 * feature) and so says nothing about the image.
 */
export const HARNESS_CONTRACT_UNREPORTED = 0;
