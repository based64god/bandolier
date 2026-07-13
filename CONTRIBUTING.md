# Contributing

Thanks for hacking on Bandolier. This is the short version of everything a
newcomer needs before pushing a change.

## Verification loop

Run all of these locally before you push — CI runs the same checks on every push
and pull request (see `.github/workflows/ci.yml`):

```bash
cd web          # the web app lives here; run pnpm commands from web/
pnpm check      # ESLint + tsc --noEmit
pnpm test       # Vitest unit suite (once)
pnpm test:e2e   # Playwright browser smoke tests over the /dev/* routes

cd ../agent-harness && go test ./...   # the Go harness suite
```

`pnpm check` and `pnpm test` cover the web app; `pnpm test:e2e` boots a dev
server and drives the UI harness routes; `go test ./...` (from `agent-harness/`)
covers the Go binary that runs inside each agent pod (and the vendored `gollm`
module it embeds).

CI runs a few more suites that need a throwaway Postgres, so they're not in the
loop above but will still gate your PR: the DB-backed integration tests
(`pnpm test:integration`) and the product-flow browser specs
(`pnpm test:e2e:flow` / `pnpm test:e2e:authflow`), plus Helm-chart linting and
OpenTofu validation. See the [Tests](README.md#tests) section for what each
suite exercises.

## The wire-contract rule

`wire-contract.json` is the single source of truth for the constants that cross
the TypeScript-server ↔ Go-harness process boundary (log markers, control
sentinels, the effort allow-list). Because the two languages can't share a
package, each side re-declares these constants in code and asserts them against
the JSON:

- TypeScript: `web/src/lib/wire-contract.test.ts`
- Go: `agent-harness/cmd/harness/wire_contract_test.go`

**If you change `wire-contract.json`, you must update the constants on both
sides** so both suites keep passing. Drift is caught in CI, not in production —
keep it that way.

## `web/patches/`

`web/patches/kysely@0.29.2.patch` is a pnpm patch (declared under
`patchedDependencies` in `web/pnpm-workspace.yaml`). It re-exports
`DEFAULT_MIGRATION_TABLE` / `DEFAULT_MIGRATION_LOCK_TABLE` from `kysely` so the
drizzle-kit tooling can reach them. It's applied automatically on
`pnpm install`.

## `skills-lock.json`

`skills-lock.json` pins the vendored `.claude/skills/neon-postgres` skill to a
specific commit of [`neondatabase/agent-skills`](https://github.com/neondatabase/agent-skills)
via a content hash, so the vendored copy can be verified against its upstream
source.
