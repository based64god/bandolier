package api

import (
	"context"
	"fmt"
	"sort"
	"sync"
)

// Provider is the adapter SPI. Complete and Stream receive requests whose
// Model field has already had its provider prefix stripped (bare provider
// model id). Providers translate to and from their native wire format;
// unsupported operations return NotSupported.
type Provider interface {
	Name() string
	Complete(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
	Stream(ctx context.Context, req *ChatRequest) (ChatStream, error)
	Embed(ctx context.Context, req *EmbeddingRequest) (*EmbeddingResponse, error)
}

// Factory constructs a provider from configuration. A zero ProviderConfig
// must produce a working provider that reads its credential from the
// provider's conventional environment variable.
type Factory func(cfg ProviderConfig) (Provider, error)

var (
	registryMu sync.RWMutex
	registry   = map[string]Factory{}
	aliases    = map[string]string{}
)

// Register installs a provider factory under a canonical name. Providers call
// this from init(); later registrations replace earlier ones so applications
// can override a built-in.
func Register(name string, f Factory) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[name] = f
}

// RegisterAlias maps an alternate spelling (e.g. "together_ai") onto a
// canonical provider name.
func RegisterAlias(alias, canonical string) {
	registryMu.Lock()
	defer registryMu.Unlock()
	aliases[alias] = canonical
}

// Resolve canonicalizes a provider name through the alias table; ok reports
// whether the resulting name is registered.
func Resolve(name string) (canonical string, ok bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if c, isAlias := aliases[name]; isAlias {
		name = c
	}
	_, ok = registry[name]
	return name, ok
}

// NewProvider constructs the named provider (aliases allowed).
func NewProvider(name string, cfg ProviderConfig) (Provider, error) {
	registryMu.RLock()
	if c, isAlias := aliases[name]; isAlias {
		name = c
	}
	f, ok := registry[name]
	registryMu.RUnlock()
	if !ok {
		return nil, &Error{
			Type:       ErrBadRequest,
			StatusCode: 400,
			Message:    fmt.Sprintf("unknown provider %q (registered: %v)", name, ProviderNames()),
		}
	}
	return f(cfg)
}

// ProviderNames lists registered canonical provider names, sorted.
func ProviderNames() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	names := make([]string, 0, len(registry))
	for n := range registry {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
