package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"syscall"
)

// ownProcessGroup makes a spawned command start its own process group rather
// than inheriting the harness's. On pod termination the container runtime
// delivers SIGTERM to the harness's process group; without this the signal
// reaches the child directly — killing the claude CLI mid-run (it exits 143 on
// SIGTERM) and racing the harness's own clean-shutdown handling. Isolating every
// child means only the harness (PID 1) receives that SIGTERM, so it alone
// decides how and when to stop its children. See main()'s signal handling.
//
// It is applied by harnessCmd, the single constructor every harness subprocess
// is built through, so every exec.Cmd the harness starts is isolated by
// construction. The value is read-only input to the runtime, so a single shared
// instance is safe.
var ownProcessGroup = &syscall.SysProcAttr{Setpgid: true}

// harnessCmd builds an exec.Cmd for a harness-spawned subprocess with its own
// process group already set (see ownProcessGroup). Every subprocess the harness
// starts is constructed here — never with exec.Command/exec.CommandContext
// directly — so the isolation invariant holds by construction and a new call
// site cannot silently reintroduce the pod-SIGTERM race. Pass a nil ctx for the
// spawns the harness stops itself (e.g. the interactive claude driver, ended by
// closing its stdin) rather than through context cancellation.
func harnessCmd(ctx context.Context, name string, args ...string) *exec.Cmd {
	var cmd *exec.Cmd
	if ctx == nil {
		cmd = exec.Command(name, args...)
	} else {
		cmd = exec.CommandContext(ctx, name, args...)
	}
	cmd.SysProcAttr = ownProcessGroup
	return cmd
}

// ── Subprocess execution ────────────────────────────────────────────────────

// forEachLine reads r line by line, invoking fn for every non-blank line
// (newline stripped by ReadBytes but passed through as received). ReadBytes (not
// Scanner) avoids line-length limits — NDJSON lines can be large when they embed
// tool inputs or file contents. It returns once the reader is exhausted.
func forEachLine(r io.Reader, fn func([]byte)) {
	reader := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			fn(line)
		}
		if err != nil {
			return
		}
	}
}

// captureCmd runs a command capturing stdout (returned), while streaming stderr
// into the tagged harness logs.
func captureCmd(ctx context.Context, dir, name string, args ...string) (string, error) {
	return captureCmdEnv(ctx, dir, os.Environ(), name, args...)
}

// captureCombined runs a command capturing stdout and stderr together, for
// callers that need to inspect both (e.g. distinguishing a gh "already exists"
// notice on stderr from a real failure).
func captureCombined(ctx context.Context, dir, name string, args ...string) (string, error) {
	var buf bytes.Buffer
	cmd := harnessCmd(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

// captureCmdEnv is captureCmd with an explicit environment (e.g. the Bedrock-
// flagged env for an out-of-band claude invocation).
func captureCmdEnv(ctx context.Context, dir string, env []string, name string, args ...string) (string, error) {
	w := &prefixWriter{}
	var stdout bytes.Buffer
	cmd := harnessCmd(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdout = &stdout
	cmd.Stderr = w
	err := cmd.Run()
	w.flush()
	return stdout.String(), err
}

// prefixWriter re-emits each complete line it receives through log.Printf with
// the [harness] tag, so subprocess output (git, gh) is filtered as harness noise
// in the UI rather than mistaken for Claude's output.
type prefixWriter struct {
	buf []byte
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		log.Printf("[harness] %s", w.buf[:i])
		w.buf = w.buf[i+1:]
	}
	return len(p), nil
}

func (w *prefixWriter) flush() {
	if len(w.buf) > 0 {
		log.Printf("[harness] %s", w.buf)
		w.buf = nil
	}
}

// runCmd runs a harness-orchestrated command (git, gh), tagging its output with
// [harness]. The same writer backs stdout and stderr; exec serializes writes
// when both are the same writer, so lines won't interleave mid-write.
func runCmd(ctx context.Context, dir string, env []string, name string, args ...string) error {
	w := &prefixWriter{}
	cmd := harnessCmd(ctx, name, args...)
	cmd.Dir = dir
	cmd.Stdout = w
	cmd.Stderr = w
	cmd.Env = env
	err := cmd.Run()
	w.flush()
	return err
}

// getenvDefault returns the environment value for key, or def when it is unset
// or empty.
func getenvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
