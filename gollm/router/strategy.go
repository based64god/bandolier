package router

import (
	"fmt"
	"math"
	"math/rand/v2"
	"sync"
)

// Strategy names accepted in Config.Strategy.
const (
	StrategySimpleShuffle = "simple-shuffle"
	StrategyRoundRobin    = "round-robin"
	StrategyLeastBusy     = "least-busy"
	StrategyLatencyBased  = "latency-based"
)

// strategy picks one deployment among the (non-empty) healthy candidates for
// an alias. Implementations must be safe for concurrent use.
type strategy interface {
	pick(alias string, candidates []*deployment) *deployment
}

// strategyAliases maps litellm's documented routing_strategy spellings onto
// the native names. Usage-based routing's closest analog here is least-busy:
// both steer toward the least-loaded deployment, ours by in-flight count.
var strategyAliases = map[string]string{
	"latency-based-routing":  StrategyLatencyBased,
	"usage-based-routing":    StrategyLeastBusy,
	"usage-based-routing-v2": StrategyLeastBusy,
}

func newStrategy(name string) (strategy, error) {
	if canonical, ok := strategyAliases[name]; ok {
		name = canonical
	}
	switch name {
	case StrategySimpleShuffle:
		return simpleShuffle{}, nil
	case StrategyRoundRobin:
		return &roundRobin{counters: map[string]uint64{}}, nil
	case StrategyLeastBusy:
		return leastBusy{}, nil
	case StrategyLatencyBased:
		return latencyBased{}, nil
	default:
		return nil, fmt.Errorf("router: unknown strategy %q (want %s, %s, %s, %s, or litellm spellings latency-based-routing, usage-based-routing, usage-based-routing-v2)",
			name, StrategySimpleShuffle, StrategyRoundRobin, StrategyLeastBusy, StrategyLatencyBased)
	}
}

// simpleShuffle is litellm's default: weighted random (Weight ≤ 0 counts as 1).
type simpleShuffle struct{}

func (simpleShuffle) pick(_ string, candidates []*deployment) *deployment {
	total := 0
	for _, d := range candidates {
		total += weightOf(d)
	}
	n := rand.IntN(total)
	for _, d := range candidates {
		n -= weightOf(d)
		if n < 0 {
			return d
		}
	}
	return candidates[len(candidates)-1]
}

func weightOf(d *deployment) int {
	if d.Params.Weight > 0 {
		return d.Params.Weight
	}
	return 1
}

// roundRobin cycles a per-alias counter over the candidate list. The list
// shrinks while peers are cooling, which skews the cycle — acceptable, as in
// litellm.
type roundRobin struct {
	mu       sync.Mutex
	counters map[string]uint64
}

func (rr *roundRobin) pick(alias string, candidates []*deployment) *deployment {
	rr.mu.Lock()
	n := rr.counters[alias]
	rr.counters[alias] = n + 1
	rr.mu.Unlock()
	return candidates[n%uint64(len(candidates))]
}

// leastBusy picks the fewest in-flight requests, ties broken randomly so a
// cold start doesn't hammer the first deployment.
type leastBusy struct{}

func (leastBusy) pick(_ string, candidates []*deployment) *deployment {
	var best []*deployment
	min := int64(math.MaxInt64)
	for _, d := range candidates {
		switch n := d.inFlight.Load(); {
		case n < min:
			min, best = n, append(best[:0], d)
		case n == min:
			best = append(best, d)
		}
	}
	return best[rand.IntN(len(best))]
}

// latencyBased picks the lowest EWMA of attempt latency; deployments with no
// samples yet are preferred so each one gets measured.
type latencyBased struct{}

func (latencyBased) pick(_ string, candidates []*deployment) *deployment {
	var unseen []*deployment
	var best *deployment
	bestLat := math.MaxFloat64
	for _, d := range candidates {
		lat, ok := d.latency()
		if !ok {
			unseen = append(unseen, d)
			continue
		}
		if lat < bestLat {
			bestLat, best = lat, d
		}
	}
	if len(unseen) > 0 {
		return unseen[rand.IntN(len(unseen))]
	}
	return best
}
