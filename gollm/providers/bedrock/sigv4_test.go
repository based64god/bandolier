package bedrock

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestSigV4DocsVector pins the signer to the canonical example from the AWS
// SigV4 documentation (GET iam.amazonaws.com ListUsers, 2015-08-30), checking
// the canonical request hash, signed-headers list, and final signature.
func TestSigV4DocsVector(t *testing.T) {
	creds := awsCredentials{
		accessKeyID:     "AKIDEXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		region:          "us-east-1",
	}
	headers := map[string]string{
		"content-type": "application/x-www-form-urlencoded; charset=utf-8",
		"host":         "iam.amazonaws.com",
		"x-amz-date":   "20150830T123600Z",
	}
	query := canonicalQuery("Action=ListUsers&Version=2010-05-08")
	if query != "Action=ListUsers&Version=2010-05-08" {
		t.Fatalf("canonicalQuery = %q", query)
	}

	canonical, signed := canonicalRequest("GET", "/", query, headers, hexSHA256(nil))
	if signed != "content-type;host;x-amz-date" {
		t.Errorf("signed headers = %q", signed)
	}
	const wantCanonicalHash = "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59"
	if got := hexSHA256([]byte(canonical)); got != wantCanonicalHash {
		t.Errorf("canonical request hash = %s, want %s\ncanonical request:\n%s", got, wantCanonicalHash, canonical)
	}

	now := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
	auth := signV4("GET", "/", query, headers, nil, creds, "iam", now)
	want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
		"SignedHeaders=content-type;host;x-amz-date, " +
		"Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
	if auth != want {
		t.Errorf("authorization:\n got %s\nwant %s", auth, want)
	}
}

// TestSignRequest checks the header-stamping path: date/session-token headers
// set, session token included in the signed-headers list, deterministic
// output for fixed inputs.
func TestSignRequest(t *testing.T) {
	creds := awsCredentials{
		accessKeyID:     "AKIDEXAMPLE",
		secretAccessKey: "secret",
		sessionToken:    "session-token",
		region:          "us-west-2",
	}
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	sign := func() *http.Request {
		req, err := http.NewRequest(http.MethodPost,
			"https://bedrock-runtime.us-west-2.amazonaws.com/model/foo%3Abar/converse",
			strings.NewReader(`{"x":1}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		signRequest(req, []byte(`{"x":1}`), creds, "bedrock", now)
		return req
	}
	req := sign()

	if got := req.Header.Get("X-Amz-Date"); got != "20260102T030405Z" {
		t.Errorf("X-Amz-Date = %q", got)
	}
	if got := req.Header.Get("X-Amz-Security-Token"); got != "session-token" {
		t.Errorf("X-Amz-Security-Token = %q", got)
	}
	auth := req.Header.Get("Authorization")
	pattern := `^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/us-west-2/bedrock/aws4_request, ` +
		`SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$`
	if !regexp.MustCompile(pattern).MatchString(auth) {
		t.Errorf("authorization %q does not match %s", auth, pattern)
	}
	if again := sign().Header.Get("Authorization"); again != auth {
		t.Errorf("signature not deterministic:\n%s\n%s", auth, again)
	}

	// SigV4 (non-S3) requires the canonical URI to be the wire path encoded
	// once more: %3A on the wire signs as %253A. signV4 itself is pinned by
	// the docs vector; this pins signRequest's path wiring.
	want := signV4(http.MethodPost, "/model/foo%253Abar/converse", "", map[string]string{
		"content-type":         "application/json",
		"host":                 "bedrock-runtime.us-west-2.amazonaws.com",
		"x-amz-date":           "20260102T030405Z",
		"x-amz-security-token": "session-token",
	}, []byte(`{"x":1}`), creds, "bedrock", now)
	if auth != want {
		t.Errorf("canonical path not double-encoded:\n got %s\nwant %s", auth, want)
	}
}

func TestCanonicalURI(t *testing.T) {
	cases := map[string]string{
		"":  "/",
		"/": "/",
		"/model/anthropic.claude-v1%3A0/converse":                                    "/model/anthropic.claude-v1%253A0/converse",
		"/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A123%3Aprofile%2Fx/converse-stream": "/model/arn%253Aaws%253Abedrock%253Aus-east-1%253A123%253Aprofile%252Fx/converse-stream",
	}
	for in, want := range cases {
		if got := canonicalURI(in); got != want {
			t.Errorf("canonicalURI(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAWSEscape(t *testing.T) {
	cases := map[string]string{
		"anthropic.claude-sonnet-4-5-20250929-v1:0": "anthropic.claude-sonnet-4-5-20250929-v1%3A0",
		"us.anthropic.claude-sonnet-4-5-v1:0":       "us.anthropic.claude-sonnet-4-5-v1%3A0",
		"arn:aws:bedrock:us-east-1:123:profile/x":   "arn%3Aaws%3Abedrock%3Aus-east-1%3A123%3Aprofile%2Fx",
	}
	for in, want := range cases {
		if got := awsEscape(in); got != want {
			t.Errorf("awsEscape(%q) = %q, want %q", in, got, want)
		}
	}
}
