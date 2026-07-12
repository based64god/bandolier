package main

import (
	"os"
	"testing"
)

// TestMain lets an e2e re-exec this very test binary as the real ACP agent. The
// interactive proxy's design self-execs os.Executable() to spawn the agent
// server (runACPProxy → exec.Command(exe, "acp-agent")); under `go test`,
// os.Executable()/os.Args[0] is the test binary, so a genuine two-half loop test
// spawns os.Args[0] with HARNESS_TEST_SUBPROCESS=acp-agent and this hook routes
// that child into serveACPAgent instead of the normal test run.
//
// The env var is set only on the child (never via t.Setenv), so the common case
// falls through to m.Run() and every existing test runs unchanged.
func TestMain(m *testing.M) {
	if os.Getenv("HARNESS_TEST_SUBPROCESS") == "acp-agent" {
		if err := runACPAgent(); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
