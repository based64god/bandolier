package main

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

// TestOwnProcessGroupIsolatesChildren asserts the SysProcAttr the harness attaches
// to every subprocess actually starts a new process group.
func TestOwnProcessGroupIsolatesChildren(t *testing.T) {
	if ownProcessGroup == nil || !ownProcessGroup.Setpgid {
		t.Fatalf("ownProcessGroup must set Setpgid so children leave the harness's group; got %+v", ownProcessGroup)
	}
	if ownProcessGroup.Pgid != 0 {
		t.Errorf("ownProcessGroup.Pgid = %d, want 0 (child becomes its own group leader)", ownProcessGroup.Pgid)
	}
}

// procGroupHarnessSrc mimics the harness under pod termination: it leads its own
// process group and ignores SIGTERM (as the real harness, which handles it), then
// starts two claude-like children — one inheriting its group, one isolated the
// way ownProcessGroup isolates the real claude. It signals its whole group (what a
// container runtime does on pod stop) and reports each child's fate: the
// non-isolated one is reached and exits 143 (claude's SIGTERM exit code), the
// isolated one survives for the harness to stop deliberately.
const procGroupHarnessSrc = `package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func claudeLike() *exec.Cmd {
	// A stand-in for the claude CLI: exits 143 on SIGTERM, like the real one.
	return exec.Command("sh", "-c", "trap 'exit 143' TERM; sleep 30")
}

func main() {
	// Lead our own group and CATCH SIGTERM (as the real harness does with
	// signal.Notify), so signalling the group leaves us standing to observe the
	// children. A caught signal — unlike an ignored one — resets to the default
	// disposition in exec'd children, so they can still be killed by it.
	_ = syscall.Setpgid(0, 0)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM)
	go func() { for range sig {} }()

	shared := claudeLike()
	isolated := claudeLike()
	isolated.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := shared.Start(); err != nil { fmt.Println("ERR", err); os.Exit(2) }
	if err := isolated.Start(); err != nil { fmt.Println("ERR", err); os.Exit(2) }

	time.Sleep(300 * time.Millisecond)
	// Container-runtime-style termination: SIGTERM to the whole process group.
	_ = syscall.Kill(-syscall.Getpgrp(), syscall.SIGTERM)
	time.Sleep(500 * time.Millisecond)

	// The non-isolated child was reached by the group signal and has exited.
	_ = shared.Wait()
	sharedExit := shared.ProcessState.ExitCode()

	// The isolated child never got the group signal — still running.
	isolatedAlive := syscall.Kill(isolated.Process.Pid, 0) == nil
	_ = isolated.Process.Kill()
	_ = isolated.Wait()

	fmt.Printf("SHARED_EXIT=%d ISOLATED_ALIVE=%v\n", sharedExit, isolatedAlive)
}
`

func TestPodSigtermDoesNotReachIsolatedChild(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("process-group signalling semantics are Linux-specific")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain unavailable")
	}
	dir := t.TempDir()
	buildToolTo(t, dir, "pgharness", procGroupHarnessSrc)

	out, err := exec.Command(dir + "/pgharness").CombinedOutput()
	if err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}
	got := strings.TrimSpace(string(out))
	// A non-isolated claude is reached by the pod's group SIGTERM and exits 143 —
	// the bug. The isolated one (how the harness now spawns claude) is untouched.
	if !strings.Contains(got, "SHARED_EXIT=143") {
		t.Errorf("expected the non-isolated child to exit 143 on the group SIGTERM; got %q", got)
	}
	if !strings.Contains(got, "ISOLATED_ALIVE=true") {
		t.Errorf("expected the isolated child to survive the group SIGTERM; got %q", got)
	}
}
