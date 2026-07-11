package bedrock

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// AWS Signature Version 4, implemented on the stdlib so no AWS SDK dependency
// is taken. Only what Bedrock needs is covered: a handful of signed headers
// and a payload signed as exact bytes (no chunked/unsigned-payload modes).

const (
	signAlgorithm = "AWS4-HMAC-SHA256"
	amzDateFormat = "20060102T150405Z"
	dateFormat    = "20060102"
)

// awsCredentials is the resolved AWS credential set plus region.
type awsCredentials struct {
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
	region          string
}

// signRequest stamps X-Amz-Date, X-Amz-Security-Token (when a session token
// is present), and Authorization onto req, signing the exact payload bytes.
// The canonical path is req.URL's escaped form, so the signed bytes match the
// wire bytes.
func signRequest(req *http.Request, payload []byte, creds awsCredentials, service string, now time.Time) {
	amzDate := now.UTC().Format(amzDateFormat)
	req.Header.Set("X-Amz-Date", amzDate)
	if creds.sessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", creds.sessionToken)
	}

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := map[string]string{"host": host, "x-amz-date": amzDate}
	if ct := req.Header.Get("Content-Type"); ct != "" {
		headers["content-type"] = ct
	}
	if creds.sessionToken != "" {
		headers["x-amz-security-token"] = creds.sessionToken
	}

	req.Header.Set("Authorization", signV4(req.Method, canonicalURI(req.URL.EscapedPath()),
		canonicalQuery(req.URL.RawQuery), headers, payload, creds, service, now))
}

// canonicalURI escapes the wire path once more for the canonical request.
// SigV4 for every service except S3 URI-encodes each path segment twice: the
// wire carries the once-encoded path and the canonical form encodes those
// bytes again ('%' → "%25"), which is what botocore and the AWS SDKs sign.
// A Bedrock wire path /model/foo%3A0/converse therefore signs as
// /model/foo%253A0/converse; signing the wire path itself yields
// SignatureDoesNotMatch.
func canonicalURI(escapedPath string) string {
	if escapedPath == "" {
		return "/"
	}
	segs := strings.Split(escapedPath, "/")
	for i, s := range segs {
		segs[i] = awsEscape(s)
	}
	return strings.Join(segs, "/")
}

// signV4 computes the Authorization header value from canonical inputs.
// headers must be lowercase-keyed and include host.
func signV4(method, path, query string, headers map[string]string, payload []byte, creds awsCredentials, service string, now time.Time) string {
	t := now.UTC()
	scope := t.Format(dateFormat) + "/" + creds.region + "/" + service + "/aws4_request"

	canonical, signedHeaders := canonicalRequest(method, path, query, headers, hexSHA256(payload))
	stringToSign := strings.Join([]string{
		signAlgorithm,
		t.Format(amzDateFormat),
		scope,
		hexSHA256([]byte(canonical)),
	}, "\n")

	key := signingKey(creds.secretAccessKey, t.Format(dateFormat), creds.region, service)
	signature := hex.EncodeToString(hmacSHA256(key, []byte(stringToSign)))

	return signAlgorithm + " Credential=" + creds.accessKeyID + "/" + scope +
		", SignedHeaders=" + signedHeaders + ", Signature=" + signature
}

// canonicalRequest builds the SigV4 canonical request and the sorted
// signed-headers list.
func canonicalRequest(method, path, query string, headers map[string]string, payloadHash string) (canonical, signedHeaders string) {
	keys := make([]string, 0, len(headers))
	for k := range headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	signedHeaders = strings.Join(keys, ";")

	var b strings.Builder
	b.WriteString(method)
	b.WriteByte('\n')
	b.WriteString(path)
	b.WriteByte('\n')
	b.WriteString(query)
	b.WriteByte('\n')
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte(':')
		b.WriteString(strings.TrimSpace(headers[k]))
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	b.WriteString(signedHeaders)
	b.WriteByte('\n')
	b.WriteString(payloadHash)
	return b.String(), signedHeaders
}

// canonicalQuery re-encodes and sorts the query string per SigV4 (strict RFC
// 3986 escaping, sorted by key then value). Bedrock requests carry no query;
// this exists so the signer is correct for the documented AWS test vector.
func canonicalQuery(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	type kv struct{ k, v string }
	var pairs []kv
	for _, p := range strings.Split(rawQuery, "&") {
		if p == "" {
			continue
		}
		k, v, _ := strings.Cut(p, "=")
		ku, _ := url.QueryUnescape(k)
		vu, _ := url.QueryUnescape(v)
		pairs = append(pairs, kv{awsEscape(ku), awsEscape(vu)})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	enc := make([]string, len(pairs))
	for i, p := range pairs {
		enc[i] = p.k + "=" + p.v
	}
	return strings.Join(enc, "&")
}

// awsEscape percent-encodes every byte outside RFC 3986's unreserved set —
// stricter than url.PathEscape, which leaves sub-delims like ":" bare, and
// exactly what SigV4 canonicalization (and Bedrock model-id paths) require.
func awsEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9',
			c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// signingKey derives the per-day SigV4 key:
// HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request").
func signingKey(secret, date, region, service string) []byte {
	k := hmacSHA256([]byte("AWS4"+secret), []byte(date))
	k = hmacSHA256(k, []byte(region))
	k = hmacSHA256(k, []byte(service))
	return hmacSHA256(k, []byte("aws4_request"))
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func hexSHA256(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
