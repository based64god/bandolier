package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

// bandolierClient is the single HTTP client the harness uses to talk to
// Bandolier's callback endpoints (transcript ingest, parent context, input
// poll, ACP relay). It reads the per-job credentials once and carries a shared
// timeout so no callback can stall a run indefinitely — several call sites
// previously used http.DefaultClient (no timeout) with the long-lived run ctx.
type bandolierClient struct {
	token string
	job   string
	http  *http.Client
}

// bando is the process-wide Bandolier client. Package-level init runs before
// main, by which point the pod has already exported the credentials into the
// environment, so the creds are read exactly once here.
var bando = newBandolierClient()

func newBandolierClient() *bandolierClient {
	return &bandolierClient{
		token: os.Getenv("BANDOLIER_INGEST_TOKEN"),
		job:   os.Getenv("BANDOLIER_JOB"),
		http:  &http.Client{Timeout: 30 * time.Second},
	}
}

// newRequest builds a request to a Bandolier endpoint with the auth headers
// every callback expects. Callers set any additional headers before calling Do.
func (c *bandolierClient) newRequest(ctx context.Context, method, url string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Bandolier-Job", c.job)
	return req, nil
}

// do executes a request on the shared client.
func (c *bandolierClient) do(req *http.Request) (*http.Response, error) {
	return c.http.Do(req)
}

func (c *bandolierClient) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return c.do(req)
}

func (c *bandolierClient) post(ctx context.Context, url, contentType string, body io.Reader) (*http.Response, error) {
	req, err := c.newRequest(ctx, http.MethodPost, url, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return c.do(req)
}

// getJSON GETs a Bandolier polling endpoint and decodes a 200 body into out.
// It returns ok=false (and leaves out untouched) on HTTP 204, the empty-queue
// signal both relay-polling loops share, so callers don't repeat the
// GET→204→non-200→decode dance. what names the endpoint for error messages.
func (c *bandolierClient) getJSON(ctx context.Context, what, url string, out any) (ok bool, err error) {
	resp, err := c.get(ctx, url)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("%s status %d", what, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return false, err
	}
	return true, nil
}

// pollLoop runs the relay-polling scaffolding shared by the interactive input
// and ACP-proxy pumps: fetch on a 2s tick, reset an idle deadline whenever fetch
// yields work, and stop on ctx cancellation, an idle timeout, or a fetch/handle
// signalling done. fetch reports progress=true when it produced work this tick;
// it should log its own transient errors. done ends the loop early (e.g. an
// end-session frame or a fatal write). what names the loop for the idle-timeout
// message. Extra stop channels (e.g. the proxy's ended) end the loop too.
func pollLoop(ctx context.Context, what string, idle time.Duration, fetch func(context.Context) (progress, done bool), stop ...<-chan struct{}) {
	deadline := time.Now().Add(idle)
	for {
		if ctx.Err() != nil {
			return
		}
		progress, done := fetch(ctx)
		if done {
			return
		}
		if progress {
			deadline = time.Now().Add(idle)
		}
		if time.Now().After(deadline) {
			log.Printf("[harness] no %s for %s — ending interactive session", what, idle)
			return
		}
		if waitOrDone(ctx, 2*time.Second, stop...) {
			return
		}
	}
}

// waitOrDone blocks for d or until ctx (or any of the extra channels) closes,
// returning true if it should stop (ctx/channel closed) rather than a timer tick.
func waitOrDone(ctx context.Context, d time.Duration, stop ...<-chan struct{}) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	// Two extra stop channels cover the current callers (the proxy's ended); a
	// fixed switch keeps the hot path allocation-free versus reflect.Select.
	var s0, s1 <-chan struct{}
	if len(stop) > 0 {
		s0 = stop[0]
	}
	if len(stop) > 1 {
		s1 = stop[1]
	}
	select {
	case <-ctx.Done():
		return true
	case <-s0:
		return true
	case <-s1:
		return true
	case <-timer.C:
		return false
	}
}
