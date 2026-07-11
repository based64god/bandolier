# Agent harness

The Go binary that runs inside each Bandolier agent pod. It reads its task
configuration from environment variables, optionally clones a git repository,
drives Claude Code, and — in issue mode — opens a pull request that closes the
issue. Non-Anthropic providers (OpenAI API key, ChatGPT subscription, Gemini,
Vertex) are served through an embedded [gollm](../gollm) proxy: the harness
starts it on localhost, points `ANTHROPIC_BASE_URL` at it, and Claude Code's
Anthropic-format traffic is translated to the run's real backend. It ships as
a container image alongside the `claude` CLI, `git`, and `gh` (see the
[Dockerfile](Dockerfile)).

## Build

```sh
# Local binary (from this directory; the vendored ../gollm module must be present):
go build ./cmd/harness        # produces ./harness

# Container image (Go binary + claude CLI + git/gh), built from the REPO ROOT so
# the vendored gollm module is in the build context:
cd .. && docker build -f agent-harness/Dockerfile -t bandolier-agent-harness .
```

The `harness` binary this leaves in the working directory is a gitignored local
build artifact — safe to delete.

## Test

```sh
go test -race ./...
```

CI runs `go test -race -count=1 ./...` (see
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)), plus `gofmt -l .`
and `go vet ./...`.

## File map

| Path | What it is |
| --- | --- |
| `cmd/harness/main.go` | Entry point. Reads env config, clones the repo, runs the agent CLI non-interactively (`--print` mode), and handles issue mode (build prompt, create branch, push, open PR). |
| `cmd/harness/acp_proxy.go` | Interactive-session proxy: relays [Agent Client Protocol](https://agentclientprotocol.com) frames between the frontend (over the HTTP relay) and the in-pod agent (over stdio), and owns session establishment. |
| `cmd/harness/acp_agent.go` | `harness acp-agent` — the ACP agent (server) side, speaking JSON-RPC over stdio. |
| `cmd/harness/tokens.go` | Per-run token accounting and the `BANDOLIER_TOKENS=` log marker the server greps for the live token readout. |
| `cmd/harness/bandolier_client.go` | The single timeout-bounded HTTP client for Bandolier's callback endpoints (transcript ingest, parent context, input poll, ACP relay). |
| `internal/acp/` | Std-lib-only implementation of the ACP subset Bandolier needs: a newline-delimited JSON-RPC 2.0 transport (`jsonrpc.go`) and the ACP method/notification types (`types.go`). |
| `k8s/manifest.yaml` | Standalone reference Job for testing the image in isolation; the running app generates equivalent Jobs itself and does not use this file. |

The `*_test.go` files cover the pure helpers (slugging, branch naming, prompt
building, PR-content parsing, provider detection, tool-use rendering, token
parsing, and the JSON-RPC transport).

## The wire contract

A handful of constants cross the TypeScript↔Go process boundary — log markers,
control sentinels, and the effort allow-list — and so cannot share a package.
Their single source of truth is [`wire-contract.json`](../wire-contract.json) at
the repo root.

Both sides assert their in-code constants against that file:

- Go: `cmd/harness/wire_contract_test.go`
- TypeScript: `src/lib/wire-contract.test.ts`

If you change a marker, sentinel, or effort level, update `wire-contract.json`
**and** the constant on both sides. Any drift breaks CI instead of silently
mismatching in production.
