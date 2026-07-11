// Package proxy implements the gollm gateway: an Anthropic-compatible
// /v1/messages endpoint (so Claude Code can point ANTHROPIC_BASE_URL at it
// and run on any backend) plus OpenAI-compatible endpoints, virtual keys,
// and spend tracking — litellm's proxy, in Go.
package proxy

import (
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/based64god/gollm/router"
)

// Config is the proxy configuration, YAML-compatible with the subset of
// litellm's proxy config that gollm implements.
type Config struct {
	ModelList       []ModelEntry    `yaml:"model_list"`
	RouterSettings  RouterSettings  `yaml:"router_settings"`
	GeneralSettings GeneralSettings `yaml:"general_settings"`
}

// ModelEntry declares one deployment: the public alias clients request and
// the provider parameters behind it. `litellm_params` is accepted as an alias
// for `params` so existing litellm configs drop in.
type ModelEntry struct {
	ModelName string      `yaml:"model_name"`
	Params    ModelParams `yaml:"params"`
	// LitellmParams mirrors Params under litellm's key; whichever is set wins
	// field-by-field (Params preferred).
	LitellmParams *ModelParams `yaml:"litellm_params"`
}

// ModelParams are the deployment parameters (router.DeploymentParams in
// config form). Secret-bearing fields support "os.environ/VAR" indirection.
type ModelParams struct {
	Model   string            `yaml:"model"`
	APIKey  string            `yaml:"api_key"`
	APIBase string            `yaml:"api_base"`
	Headers map[string]string `yaml:"headers"`
	Weight  int               `yaml:"weight"`
	RPM     int               `yaml:"rpm"`
	TPM     int               `yaml:"tpm"`
	// Passthrough forces (true) or forbids (false) verbatim forwarding for
	// Anthropic-format clients on Anthropic backends; unset = auto (on when
	// the deployment's provider is anthropic).
	Passthrough *bool `yaml:"passthrough"`
}

// RouterSettings mirror router.Config in YAML form.
type RouterSettings struct {
	RoutingStrategy string `yaml:"routing_strategy"`
	NumRetries      int    `yaml:"num_retries"`
	// Timeout is seconds (number) for litellm compatibility.
	TimeoutSeconds float64 `yaml:"timeout"`
	// Fallbacks accept litellm's list-of-single-key-maps shape.
	Fallbacks              []map[string][]string `yaml:"fallbacks"`
	ContextWindowFallbacks []map[string][]string `yaml:"context_window_fallbacks"`
	CooldownTimeSeconds    float64               `yaml:"cooldown_time"`
	AllowedFails           int                   `yaml:"allowed_fails"`
}

// GeneralSettings configure the server itself.
type GeneralSettings struct {
	// MasterKey gates every endpoint and administers virtual keys. Supports
	// os.environ/ indirection. Empty = auth disabled (development only; the
	// server logs a warning).
	MasterKey string `yaml:"master_key"`
	// KeysFile persists virtual keys and their spend as JSON; empty = memory
	// only.
	KeysFile string `yaml:"keys_file"`
}

// LoadConfig reads and resolves a YAML config file.
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	return ParseConfig(raw)
}

// ParseConfig parses YAML config bytes and resolves env indirections.
func ParseConfig(raw []byte) (*Config, error) {
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if len(cfg.ModelList) == 0 {
		return nil, fmt.Errorf("config has no model_list entries")
	}
	for i := range cfg.ModelList {
		e := &cfg.ModelList[i]
		if e.LitellmParams != nil {
			mergeParams(&e.Params, e.LitellmParams)
		}
		if e.ModelName == "" {
			return nil, fmt.Errorf("model_list[%d]: model_name is required", i)
		}
		if e.Params.Model == "" {
			return nil, fmt.Errorf("model_list[%d] (%s): params.model is required", i, e.ModelName)
		}
		e.Params.APIKey = resolveEnv(e.Params.APIKey)
		e.Params.APIBase = resolveEnv(e.Params.APIBase)
	}
	cfg.GeneralSettings.MasterKey = resolveEnv(cfg.GeneralSettings.MasterKey)
	return &cfg, nil
}

func mergeParams(dst, src *ModelParams) {
	if dst.Model == "" {
		dst.Model = src.Model
	}
	if dst.APIKey == "" {
		dst.APIKey = src.APIKey
	}
	if dst.APIBase == "" {
		dst.APIBase = src.APIBase
	}
	if dst.Headers == nil {
		dst.Headers = src.Headers
	}
	if dst.Weight == 0 {
		dst.Weight = src.Weight
	}
	if dst.RPM == 0 {
		dst.RPM = src.RPM
	}
	if dst.TPM == 0 {
		dst.TPM = src.TPM
	}
	if dst.Passthrough == nil {
		dst.Passthrough = src.Passthrough
	}
}

// resolveEnv expands litellm's "os.environ/VAR" indirection.
func resolveEnv(v string) string {
	if name, ok := strings.CutPrefix(v, "os.environ/"); ok {
		return os.Getenv(name)
	}
	return v
}

// RouterConfig converts the YAML settings into a router.Config.
func (c *Config) RouterConfig() router.Config {
	rc := router.Config{
		Strategy:               c.RouterSettings.RoutingStrategy,
		NumRetries:             c.RouterSettings.NumRetries,
		Timeout:                time.Duration(c.RouterSettings.TimeoutSeconds * float64(time.Second)),
		CooldownTime:           time.Duration(c.RouterSettings.CooldownTimeSeconds * float64(time.Second)),
		AllowedFails:           c.RouterSettings.AllowedFails,
		Fallbacks:              flattenFallbacks(c.RouterSettings.Fallbacks),
		ContextWindowFallbacks: flattenFallbacks(c.RouterSettings.ContextWindowFallbacks),
	}
	for i, e := range c.ModelList {
		rc.Deployments = append(rc.Deployments, router.Deployment{
			ID:        fmt.Sprintf("%s-%d", e.ModelName, i),
			ModelName: e.ModelName,
			Params: router.DeploymentParams{
				Model:   e.Params.Model,
				APIKey:  e.Params.APIKey,
				BaseURL: e.Params.APIBase,
				Headers: e.Params.Headers,
				Weight:  e.Params.Weight,
				RPM:     e.Params.RPM,
				TPM:     e.Params.TPM,
			},
		})
	}
	return rc
}

// flattenFallbacks folds litellm's list-of-single-key-maps into one map.
func flattenFallbacks(list []map[string][]string) map[string][]string {
	if len(list) == 0 {
		return nil
	}
	out := map[string][]string{}
	for _, m := range list {
		for k, v := range m {
			out[k] = append(out[k], v...)
		}
	}
	return out
}
