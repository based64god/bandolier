package router

import (
	"context"
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"time"

	"github.com/based64god/gollm/api"
)

// attemptFunc issues one provider call against a specific deployment; model
// is the deployment's Params.Model with wildcard substitution applied.
type attemptFunc[T any] func(ctx context.Context, dep *deployment, model string) (T, error)

// attemptResult is a successful attempt. The deployment's in-flight count is
// still held: the caller finishes accounting via Router.settle (non-streaming)
// or routedStream.finish (streams).
type attemptResult[T any] struct {
	val   T
	dep   *deployment
	start time.Time
}

// runWithFallbacks runs the full attempt loop for the requested alias, then
// walks its fallback chain (context-window fallbacks first when the failure
// was a context overflow). The last error wins, annotated with the fallbacks
// tried.
func runWithFallbacks[T any](r *Router, ctx context.Context, alias string, attempt attemptFunc[T]) (attemptResult[T], error) {
	res, err := runAlias(r, ctx, alias, attempt)
	if err == nil {
		return res, nil
	}

	chain := r.fallbackChain(alias, err)
	if len(chain) == 0 {
		return res, err
	}

	var tried []string
	for _, fb := range chain {
		if ctx.Err() != nil {
			break
		}
		tried = append(tried, fb)
		res, ferr := runAlias(r, ctx, fb, attempt)
		if ferr == nil {
			return res, nil
		}
		err = ferr
	}
	var zero attemptResult[T]
	return zero, fmt.Errorf("router: %q failed and fallbacks %v failed: %w", alias, tried, err)
}

// fallbackChain orders the aliases to try after alias fails: context-window
// fallbacks first when the failure was a context overflow, then the generic
// chain, deduplicated and never the failed alias itself.
func (r *Router) fallbackChain(alias string, err error) []string {
	var chain []string
	if apiErr, ok := api.AsError(err); ok && apiErr.Type == api.ErrContextWindow {
		chain = append(chain, r.cfg.ContextWindowFallbacks[alias]...)
	}
	chain = append(chain, r.cfg.Fallbacks[alias]...)

	seen := map[string]bool{alias: true}
	out := chain[:0] // chain is freshly allocated above; in-place filter is safe
	for _, a := range chain {
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	return out
}

// runAlias picks among the alias's healthy deployments by strategy. The
// strategy's first pick gets NumRetries same-deployment retries; when it is
// exhausted the remaining healthy deployments are each tried once more (no
// per-deployment re-retry) until one succeeds or all are exhausted.
func runAlias[T any](r *Router, ctx context.Context, alias string, attempt attemptFunc[T]) (attemptResult[T], error) {
	var zero attemptResult[T]
	remaining, err := r.eligible(alias)
	if err != nil {
		return zero, err
	}

	var lastErr error
	retries := r.cfg.NumRetries
	for len(remaining) > 0 {
		dep := r.strat.pick(alias, remaining)
		for i, d := range remaining {
			if d == dep {
				remaining = slices.Delete(remaining, i, i+1)
				break
			}
		}
		res, err := attemptDeployment(r, ctx, alias, dep, attempt, retries)
		if err == nil {
			return res, nil
		}
		retries = 0 // failover peers get one attempt each, no re-retry
		lastErr = err
		if ctx.Err() != nil {
			break // caller is gone; don't burn through the remaining peers
		}
	}
	return zero, lastErr
}

// eligible returns the alias's deployment pool after cooldown filtering
// (fail-open to the whole pool when every deployment is cooling) and RPM/TPM
// limit checks. Errors are *api.Error: not_found for an unknown alias,
// rate_limit when every survivor is at its limit.
func (r *Router) eligible(alias string) ([]*deployment, error) {
	candidates := r.resolve(alias)
	if len(candidates) == 0 {
		return nil, &api.Error{
			Type:       api.ErrNotFound,
			StatusCode: 404,
			Model:      alias,
			Message: fmt.Sprintf("model %q is not routed to any deployment; known models: %s",
				alias, strings.Join(r.ModelNames(), ", ")),
		}
	}

	now := time.Now()
	healthy := make([]*deployment, 0, len(candidates))
	for _, d := range candidates {
		if !d.cooling(now) {
			healthy = append(healthy, d)
		}
	}
	if len(healthy) == 0 {
		// Fail-open (litellm): when every deployment is cooling, routing to a
		// cooled one beats failing without trying at all.
		healthy = candidates
	}
	remaining := make([]*deployment, 0, len(healthy))
	for _, d := range healthy {
		if d.underLimits(now) {
			remaining = append(remaining, d)
		}
	}
	if len(remaining) == 0 {
		return nil, &api.Error{
			Type:       api.ErrRateLimit,
			StatusCode: 429,
			Model:      alias,
			Message:    fmt.Sprintf("all deployments for %q are at their RPM/TPM limit", alias),
		}
	}
	return remaining, nil
}

// attemptHeld runs one provider call with the deployment's in-flight slot
// held. The slot stays held only on success (the caller settles it); it is
// released on error and — via the deferred check — when the adapter panics,
// so a panicking attempt cannot leak least-busy state. The panic propagates.
func attemptHeld[T any](ctx context.Context, dep *deployment, model string, attempt attemptFunc[T]) (val T, err error) {
	dep.inFlight.Add(1)
	held := false
	defer func() {
		if !held {
			dep.inFlight.Add(-1)
		}
	}()
	val, err = attempt(ctx, dep, model)
	held = err == nil
	return val, err
}

// attemptDeployment calls one deployment, retrying retryable errors on that
// same deployment up to retries times with backoff. Every failed call lands
// in the deployment's failure window (unless the caller's context ended —
// that is not the deployment's fault). On success the in-flight count stays
// held for the caller to release.
func attemptDeployment[T any](r *Router, ctx context.Context, alias string, dep *deployment, attempt attemptFunc[T], retries int) (attemptResult[T], error) {
	var zero attemptResult[T]
	model := resolvedModel(dep, alias)
	for try := 0; ; try++ {
		start := time.Now()
		dep.recordRequest(start)
		val, err := attemptHeld(ctx, dep, model, attempt)
		if err == nil {
			return attemptResult[T]{val: val, dep: dep, start: start}, nil
		}
		if ctx.Err() == nil {
			r.recordFailure(dep, err)
		}

		apiErr, ok := api.AsError(err)
		if !ok || !apiErr.Retryable() || try >= retries {
			return zero, err
		}
		if serr := sleepBackoff(ctx, r.cfg.BackoffBase, try, apiErr.RetryAfter); serr != nil {
			return zero, serr
		}
	}
}

// recordFailure feeds one failed call into the deployment's cooldown
// accounting. Auth failures cool down immediately; status 499 marks caller
// cancellation (api.WrapTransport) and is never the deployment's fault.
func (r *Router) recordFailure(dep *deployment, err error) {
	apiErr, ok := api.AsError(err)
	if ok && apiErr.StatusCode == 499 {
		return
	}
	immediate := ok && apiErr.Type == api.ErrAuthentication
	dep.recordFailure(time.Now(), immediate, r.cfg.AllowedFails, r.cfg.CooldownTime)
}

// sleepBackoff waits base*2^attempt plus up to 25% jitter, or the provider's
// Retry-After when that is larger, honoring context cancellation.
func sleepBackoff(ctx context.Context, base time.Duration, attempt int, retryAfter time.Duration) error {
	if attempt > 16 {
		attempt = 16 // clamp the shift; anything beyond is hours already
	}
	d := base << uint(attempt)
	d += time.Duration(rand.Int64N(int64(d/4) + 1))
	if retryAfter > d {
		d = retryAfter
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return api.WrapTransport("router", "", ctx.Err())
	case <-t.C:
		return nil
	}
}
