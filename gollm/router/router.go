// Package router implements litellm's Router on top of the gollm client:
// public model aliases map onto pools of named deployments, requests are
// load-balanced by a pluggable strategy, retryable failures are retried on
// the same deployment with exponential backoff, repeatedly failing
// deployments are cooled down, and exhausted aliases walk configured
// fallback chains.
package router

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/based64god/gollm"
	"github.com/based64god/gollm/api"
)

// DeploymentParams are the routing overrides one deployment applies to each
// request it serves.
type DeploymentParams struct {
	Model   string // gollm model string, e.g. "openai/gpt-4o"
	APIKey  string
	BaseURL string
	Headers map[string]string
	Weight  int // simple-shuffle weight; 0 → 1
	RPM     int // 0 = unlimited (sliding 60s window)
	TPM     int // 0 = unlimited (sliding 60s window, from response usage)
}

// Deployment is one named backend serving a public model alias. Several
// deployments may share a ModelName — that is the load-balancing pool.
type Deployment struct {
	ID        string // unique; empty → "<ModelName>-<i>" assigned by New
	ModelName string // public alias clients request, e.g. "claude-sonnet-4-5"
	Params    DeploymentParams
}

// Config configures a Router. Zero values take the documented defaults.
type Config struct {
	Deployments            []Deployment
	Strategy               string              // "simple-shuffle" (default) | "round-robin" | "least-busy" | "latency-based"; litellm spellings "latency-based-routing" and "usage-based-routing(-v2)" accepted
	NumRetries             int                 // same-deployment retries for retryable errors (default 0)
	Timeout                time.Duration       // per-attempt; set on req.Timeout for non-streaming
	Fallbacks              map[string][]string // alias → ordered fallback aliases
	ContextWindowFallbacks map[string][]string
	CooldownTime           time.Duration // default 60s
	AllowedFails           int           // failures in the window before cooldown (default 3)
	BackoffBase            time.Duration // default 250ms, exponential + jitter, honor *api.Error.RetryAfter when larger
}

// Router load-balances unified requests across deployments. Safe for
// concurrent use.
type Router struct {
	client *gollm.Client
	cfg    Config
	strat  strategy

	deployments []*deployment
	byAlias     map[string][]*deployment
	// wildcards are deployments whose ModelName ends in "*", in config order;
	// consulted only when no exact alias matches.
	wildcards []*deployment
}

// New validates the config and builds a Router. A nil client gets a fresh
// gollm.New() (default provider configs, env credentials).
func New(client *gollm.Client, cfg Config) (*Router, error) {
	if len(cfg.Deployments) == 0 {
		return nil, errors.New("router: at least one deployment is required")
	}
	if client == nil {
		client = gollm.New()
	}
	if cfg.Strategy == "" {
		cfg.Strategy = StrategySimpleShuffle
	}
	if cfg.CooldownTime <= 0 {
		cfg.CooldownTime = 60 * time.Second
	}
	if cfg.AllowedFails <= 0 {
		cfg.AllowedFails = 3
	}
	if cfg.BackoffBase <= 0 {
		cfg.BackoffBase = 250 * time.Millisecond
	}

	strat, err := newStrategy(cfg.Strategy)
	if err != nil {
		return nil, err
	}

	r := &Router{
		client:  client,
		cfg:     cfg,
		strat:   strat,
		byAlias: make(map[string][]*deployment),
	}
	seen := make(map[string]bool, len(cfg.Deployments))
	for i, d := range cfg.Deployments {
		if d.ModelName == "" {
			return nil, fmt.Errorf("router: deployment %d has no ModelName", i)
		}
		if d.Params.Model == "" {
			return nil, fmt.Errorf("router: deployment %q has no Params.Model", d.ModelName)
		}
		if d.ID == "" {
			d.ID = fmt.Sprintf("%s-%d", d.ModelName, i)
		}
		if seen[d.ID] {
			return nil, fmt.Errorf("router: duplicate deployment ID %q", d.ID)
		}
		seen[d.ID] = true

		dep := &deployment{Deployment: d}
		r.deployments = append(r.deployments, dep)
		r.byAlias[d.ModelName] = append(r.byAlias[d.ModelName], dep)
		if strings.HasSuffix(d.ModelName, "*") {
			r.wildcards = append(r.wildcards, dep)
		}
	}
	return r, nil
}

// Client returns the underlying gollm client.
func (r *Router) Client() *gollm.Client { return r.client }

// ModelNames lists the sorted unique aliases this router serves (wildcard
// entries verbatim, e.g. "claude-*").
func (r *Router) ModelNames() []string {
	names := make([]string, 0, len(r.byAlias))
	for n := range r.byAlias {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// HasModel reports whether alias resolves to any deployment, exactly or via
// a wildcard ModelName.
func (r *Router) HasModel(alias string) bool { return len(r.resolve(alias)) > 0 }

// resolve returns the deployment pool for an alias: exact ModelName matches
// win; otherwise every wildcard deployment whose prefix matches.
func (r *Router) resolve(alias string) []*deployment {
	if deps := r.byAlias[alias]; len(deps) > 0 {
		return deps
	}
	var matches []*deployment
	for _, d := range r.wildcards {
		if strings.HasPrefix(alias, strings.TrimSuffix(d.ModelName, "*")) {
			matches = append(matches, d)
		}
	}
	return matches
}

// resolvedModel applies litellm's wildcard model substitution to a starred
// Params.Model. A provider passthrough — the star is the entire model segment,
// as in "openai/*" or bare "*" — receives the full requested alias
// ("openai/*" + "gpt-4o" → "openai/gpt-4o"). A patterned model like
// "bedrock/anthropic.*" receives only the segment the ModelName wildcard
// captured from the alias (litellm PatternMatchRouter.set_deployment_model_name:
// ModelName "claude-*", alias "claude-3-5-sonnet" → captured "3-5-sonnet").
// An exact ModelName match substitutes the whole requested alias.
func resolvedModel(d *deployment, alias string) string {
	prefix, starred := strings.CutSuffix(d.Params.Model, "*")
	if !starred {
		return d.Params.Model
	}
	if prefix == "" || strings.HasSuffix(prefix, "/") {
		return prefix + alias
	}
	if mnPrefix, ok := strings.CutSuffix(d.ModelName, "*"); ok {
		if captured, ok := strings.CutPrefix(alias, mnPrefix); ok {
			return prefix + captured
		}
	}
	return prefix + alias
}

// chatRequestFor copies the request with the deployment's routing params
// applied. Deployment headers overlay request headers; the router timeout
// applies per attempt, only when the caller set none, and never to streams
// (it would sever long generations mid-flight).
func (r *Router) chatRequestFor(req *api.ChatRequest, dep *deployment, model string, streaming bool) *api.ChatRequest {
	local := *req
	local.Model = model
	p := dep.Params
	if p.APIKey != "" {
		local.APIKey = p.APIKey
	}
	if p.BaseURL != "" {
		local.BaseURL = p.BaseURL
	}
	if len(p.Headers) > 0 {
		merged := make(map[string]string, len(req.Headers)+len(p.Headers))
		for k, v := range req.Headers {
			merged[k] = v
		}
		for k, v := range p.Headers {
			merged[k] = v
		}
		local.Headers = merged
	}
	if !streaming && local.Timeout == 0 {
		local.Timeout = r.cfg.Timeout
	}
	return &local
}

// Completion routes a non-streaming chat completion.
func (r *Router) Completion(ctx context.Context, req *api.ChatRequest) (*api.ChatResponse, error) {
	res, err := runWithFallbacks(r, ctx, req.Model,
		func(ctx context.Context, dep *deployment, model string) (*api.ChatResponse, error) {
			return r.client.Completion(ctx, r.chatRequestFor(req, dep, model, false))
		})
	if err != nil {
		return nil, err
	}
	r.settle(res.dep, res.start, res.val.Usage)
	return res.val, nil
}

// Stream routes a streaming chat completion. Selection, retries, and
// fallbacks apply to OBTAINING the stream; once data is flowing, mid-stream
// errors are surfaced (and recorded) but never re-routed — the caller has
// already consumed part of the response.
func (r *Router) Stream(ctx context.Context, req *api.ChatRequest) (api.ChatStream, error) {
	res, err := runWithFallbacks(r, ctx, req.Model,
		func(ctx context.Context, dep *deployment, model string) (api.ChatStream, error) {
			return r.client.Stream(ctx, r.chatRequestFor(req, dep, model, true))
		})
	if err != nil {
		return nil, err
	}
	return &routedStream{inner: res.val, r: r, dep: res.dep, start: res.start}, nil
}

// Embedding routes an embeddings request through the same selection loop.
func (r *Router) Embedding(ctx context.Context, req *api.EmbeddingRequest) (*api.EmbeddingResponse, error) {
	res, err := runWithFallbacks(r, ctx, req.Model,
		func(ctx context.Context, dep *deployment, model string) (*api.EmbeddingResponse, error) {
			local := *req
			local.Model = model
			p := dep.Params
			if p.APIKey != "" {
				local.APIKey = p.APIKey
			}
			if p.BaseURL != "" {
				local.BaseURL = p.BaseURL
			}
			if len(p.Headers) > 0 {
				merged := make(map[string]string, len(req.Headers)+len(p.Headers))
				for k, v := range req.Headers {
					merged[k] = v
				}
				for k, v := range p.Headers {
					merged[k] = v
				}
				local.Headers = merged
			}
			// EmbeddingRequest carries no Timeout field; bound via context.
			if r.cfg.Timeout > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, r.cfg.Timeout)
				defer cancel()
			}
			return r.client.Embedding(ctx, &local)
		})
	if err != nil {
		return nil, err
	}
	r.settle(res.dep, res.start, res.val.Usage)
	return res.val, nil
}

// settle finishes a successful non-streaming attempt: releases in-flight,
// records latency into the EWMA, and charges usage to the TPM window.
func (r *Router) settle(dep *deployment, start time.Time, usage *api.Usage) {
	dep.inFlight.Add(-1)
	dep.recordLatency(time.Since(start))
	if usage != nil {
		dep.recordUsage(time.Now(), usage.TotalTokens)
	}
}

// SelectDeployment picks one healthy deployment for alias using the
// configured strategy (honoring cooldowns and RPM limits), tracks it as
// in-flight, and returns it with a release callback. release(ok, usage)
// records success/failure (feeding cooldowns and latency/least-busy state)
// and decrements in-flight; usage may be nil, extra releases are no-ops.
// For raw passthrough that streams bytes and cannot be re-routed mid-stream
// — hence one deployment, no fallback. The returned Deployment is a copy
// with wildcard substitution applied to Params.Model. Returns *api.Error
// (ErrNotFound) when the alias is unknown.
func (r *Router) SelectDeployment(alias string) (*Deployment, func(ok bool, usage *api.Usage), error) {
	candidates, err := r.eligible(alias)
	if err != nil {
		return nil, nil, err
	}
	dep := r.strat.pick(alias, candidates)
	start := time.Now()
	dep.recordRequest(start)
	dep.inFlight.Add(1)

	out := dep.Deployment
	out.Params.Model = resolvedModel(dep, alias)

	var once sync.Once
	release := func(ok bool, usage *api.Usage) {
		once.Do(func() {
			if ok {
				r.settle(dep, start, usage)
				return
			}
			dep.inFlight.Add(-1)
			dep.recordFailure(time.Now(), false, r.cfg.AllowedFails, r.cfg.CooldownTime)
		})
	}
	return &out, release, nil
}
