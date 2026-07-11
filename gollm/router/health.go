package router

import (
	"sync"
	"sync/atomic"
	"time"
)

// rateWindow is the sliding interval for failure counting and RPM/TPM limits.
const rateWindow = 60 * time.Second

// ewmaAlpha weights the newest latency sample in the latency-based strategy.
const ewmaAlpha = 0.3

// deployment couples static config with mutable routing state. inFlight is
// atomic because least-busy reads it on every pick; the rest is guarded by mu.
type deployment struct {
	Deployment

	inFlight atomic.Int64

	mu            sync.Mutex
	failures      []time.Time // failure timestamps inside the sliding window
	cooldownUntil time.Time
	ewma          float64 // seconds
	ewmaSet       bool
	rpm           window
	tpm           window
}

func (d *deployment) cooling(now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return now.Before(d.cooldownUntil)
}

// underLimits reports whether the deployment has RPM/TPM headroom.
func (d *deployment) underLimits(now time.Time) bool {
	if d.Params.RPM <= 0 && d.Params.TPM <= 0 {
		return true
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.Params.RPM > 0 && d.rpm.sum(now) >= d.Params.RPM {
		return false
	}
	if d.Params.TPM > 0 && d.tpm.sum(now) >= d.Params.TPM {
		return false
	}
	return true
}

// recordRequest counts one outbound provider call against the RPM window.
func (d *deployment) recordRequest(now time.Time) {
	if d.Params.RPM <= 0 {
		return
	}
	d.mu.Lock()
	d.rpm.add(now, 1)
	d.mu.Unlock()
}

// recordUsage charges response tokens against the TPM window.
func (d *deployment) recordUsage(now time.Time, tokens int) {
	if d.Params.TPM <= 0 || tokens <= 0 {
		return
	}
	d.mu.Lock()
	d.tpm.add(now, tokens)
	d.mu.Unlock()
}

func (d *deployment) recordLatency(sample time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := sample.Seconds()
	if !d.ewmaSet {
		d.ewma, d.ewmaSet = s, true
		return
	}
	d.ewma = ewmaAlpha*s + (1-ewmaAlpha)*d.ewma
}

func (d *deployment) latency() (seconds float64, ok bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.ewma, d.ewmaSet
}

// recordFailure appends to the sliding failure window and starts a cooldown
// once failures exceed allowed. immediate skips the window entirely (auth
// failures: a bad credential cannot heal by retrying). Entering cooldown
// resets the window so the deployment gets a clean slate afterwards.
func (d *deployment) recordFailure(now time.Time, immediate bool, allowed int, cooldown time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if immediate {
		d.failures = nil
		d.cooldownUntil = now.Add(cooldown)
		return
	}
	keep := d.failures[:0]
	for _, t := range d.failures {
		if now.Sub(t) < rateWindow {
			keep = append(keep, t)
		}
	}
	d.failures = append(keep, now)
	if len(d.failures) > allowed {
		d.failures = nil
		d.cooldownUntil = now.Add(cooldown)
	}
}

// window is a sliding-60s accumulator (request counts or token counts).
// Callers synchronize access (deployment.mu).
type window struct {
	entries []windowEntry
}

type windowEntry struct {
	at time.Time
	n  int
}

func (w *window) add(now time.Time, n int) {
	w.prune(now)
	w.entries = append(w.entries, windowEntry{at: now, n: n})
}

func (w *window) sum(now time.Time) int {
	w.prune(now)
	total := 0
	for _, e := range w.entries {
		total += e.n
	}
	return total
}

func (w *window) prune(now time.Time) {
	cut := 0
	for cut < len(w.entries) && now.Sub(w.entries[cut].at) >= rateWindow {
		cut++
	}
	if cut > 0 {
		w.entries = append(w.entries[:0], w.entries[cut:]...)
	}
}
