package main

import (
	"context"
	"io"
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
