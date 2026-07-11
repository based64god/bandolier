package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// uploadTranscript must report the run's terminal state so the persisted run
// row can show Succeeded/Failed after the pod (whose phase is the live source)
// is gone.
func TestUploadTranscriptStatusHeader(t *testing.T) {
	for _, tc := range []struct {
		failed bool
		want   string
	}{
		{failed: false, want: "Succeeded"},
		{failed: true, want: "Failed"},
	} {
		var got string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got = r.Header.Get("X-Bandolier-Status")
		}))

		t.Setenv("BANDOLIER_INGEST_URL", srv.URL)
		orig := bando
		bando = &bandolierClient{token: "tok", job: "job-1", http: srv.Client()}

		uploadTranscript(tc.failed)

		bando = orig
		srv.Close()

		if got != tc.want {
			t.Errorf("failed=%v: X-Bandolier-Status = %q, want %q", tc.failed, got, tc.want)
		}
	}
}
