package oci

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/based64god/gollm/api"
)

// testKey generates an RSA key and returns it with its PEM encoding.
func testKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemData := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return key, string(pemData)
}

func setOCIEnv(t *testing.T, pemData string) {
	t.Helper()
	t.Setenv("OCI_USER", "ocid1.user.oc1..u")
	t.Setenv("OCI_FINGERPRINT", "aa:bb:cc")
	t.Setenv("OCI_TENANCY", "ocid1.tenancy.oc1..t")
	t.Setenv("OCI_COMPARTMENT_ID", "ocid1.compartment.oc1..c")
	t.Setenv("OCI_REGION", "us-ashburn-1")
	t.Setenv("OCI_KEY", pemData)
	t.Setenv("OCI_KEY_FILE", "")
	t.Setenv("OCI_API_BASE", "")
}

var authRe = regexp.MustCompile(`keyId="([^"]+)",algorithm="rsa-sha256",headers="([^"]+)",signature="([^"]+)"`)

// verifySignature reconstructs the signing string from the request the server
// saw and verifies it against the public key.
func verifySignature(t *testing.T, r *http.Request, body []byte, pub *rsa.PublicKey) {
	t.Helper()
	m := authRe.FindStringSubmatch(r.Header.Get("Authorization"))
	if m == nil {
		t.Fatalf("Authorization not an OCI signature: %q", r.Header.Get("Authorization"))
	}
	if m[1] != "ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb:cc" {
		t.Errorf("keyId = %q", m[1])
	}

	digest := sha256.Sum256(body)
	if got := r.Header.Get("X-Content-Sha256"); got != base64.StdEncoding.EncodeToString(digest[:]) {
		t.Errorf("x-content-sha256 = %q, want the body digest", got)
	}

	values := map[string]string{
		"date":             r.Header.Get("Date"),
		"(request-target)": strings.ToLower(r.Method) + " " + r.URL.RequestURI(),
		"host":             r.Host,
		"content-length":   r.Header.Get("Content-Length"),
		"content-type":     r.Header.Get("Content-Type"),
		"x-content-sha256": r.Header.Get("X-Content-Sha256"),
	}
	var lines []string
	for _, name := range strings.Split(m[2], " ") {
		lines = append(lines, name+": "+values[name])
	}
	signingString := strings.Join(lines, "\n")

	sig, err := base64.StdEncoding.DecodeString(m[3])
	if err != nil {
		t.Fatalf("signature not base64: %v", err)
	}
	hashed := sha256.Sum256([]byte(signingString))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, hashed[:], sig); err != nil {
		t.Errorf("signature does not verify: %v\nsigning string:\n%s", err, signingString)
	}
}

func TestOCIGenericCompleteSignedAndTranslated(t *testing.T) {
	key, pemData := testKey(t)
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/20231130/actions/chat" {
			t.Errorf("path = %q", r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		verifySignature(t, r, raw, &key.PublicKey)
		_ = json.Unmarshal(raw, &gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"modelId": "meta.llama-3.3-70b-instruct",
			"chatResponse": map[string]any{
				"apiFormat": "GENERIC",
				"choices": []map[string]any{{
					"index": 0,
					"message": map[string]any{
						"role":    "ASSISTANT",
						"content": []map[string]string{{"type": "TEXT", "text": "hi from oci"}},
						"toolCalls": []map[string]string{{
							"id": "call_1", "type": "FUNCTION", "name": "read", "arguments": `{"path":"a"}`,
						}},
					},
					"finishReason": "tool_calls",
				}},
				"usage": map[string]int{"promptTokens": 5, "completionTokens": 7, "totalTokens": 12},
			},
		})
	}))
	defer srv.Close()

	setOCIEnv(t, pemData)
	p, err := api.NewProvider("oci", api.ProviderConfig{BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model: "meta.llama-3.3-70b-instruct",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("be brief")},
			{Role: "user", Content: api.TextContent("hello")},
		},
		Tools: []api.Tool{{Type: "function", Function: api.ToolFunction{
			Name: "read", Parameters: json.RawMessage(`{"type":"object"}`),
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if gotBody["compartmentId"] != "ocid1.compartment.oc1..c" {
		t.Errorf("compartmentId = %v", gotBody["compartmentId"])
	}
	sm, _ := gotBody["servingMode"].(map[string]any)
	if sm["servingType"] != "ON_DEMAND" || sm["modelId"] != "meta.llama-3.3-70b-instruct" {
		t.Errorf("servingMode = %v", sm)
	}
	cr, _ := gotBody["chatRequest"].(map[string]any)
	if cr["apiFormat"] != "GENERIC" {
		t.Errorf("apiFormat = %v", cr["apiFormat"])
	}
	msgs, _ := cr["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages = %v", cr["messages"])
	}
	first, _ := msgs[0].(map[string]any)
	if first["role"] != "SYSTEM" {
		t.Errorf("first role = %v, want SYSTEM", first["role"])
	}
	tools, _ := cr["tools"].([]any)
	if len(tools) != 1 {
		t.Errorf("tools = %v", cr["tools"])
	}

	if got := resp.Choices[0].Message.Content.AsText(); got != "hi from oci" {
		t.Errorf("content = %q", got)
	}
	calls := resp.Choices[0].Message.ToolCalls
	if len(calls) != 1 || calls[0].Function.Name != "read" || calls[0].Function.Arguments != `{"path":"a"}` {
		t.Errorf("tool calls = %+v", calls)
	}
	if resp.Choices[0].FinishReason != "tool_calls" {
		t.Errorf("finish = %q", resp.Choices[0].FinishReason)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 12 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestOCIGenericStream(t *testing.T) {
	_, pemData := testKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		cr, _ := body["chatRequest"].(map[string]any)
		if cr["isStream"] != true {
			t.Errorf("isStream = %v", cr["isStream"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"index":0,"message":{"role":"ASSISTANT","content":[{"type":"TEXT","text":"Hel"}]}}`+"\n\n")
		fmt.Fprint(w, `data: {"index":0,"message":{"role":"ASSISTANT","content":[{"type":"TEXT","text":"lo"}]},"finishReason":"stop","usage":{"promptTokens":2,"completionTokens":2,"totalTokens":4}}`+"\n\n")
	}))
	defer srv.Close()

	setOCIEnv(t, pemData)
	p, _ := api.NewProvider("oci", api.ProviderConfig{BaseURL: srv.URL})
	stream, err := p.Stream(context.Background(), &api.ChatRequest{
		Model:    "meta.llama-3.3-70b-instruct",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	acc := api.NewStreamAccumulator()
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		acc.Add(chunk)
	}
	resp := acc.Response()
	if got := resp.Choices[0].Message.Content.AsText(); got != "Hello" {
		t.Errorf("accumulated = %q", got)
	}
	if resp.Usage == nil || resp.Usage.TotalTokens != 4 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestOCICohereFormat(t *testing.T) {
	_, pemData := testKey(t)
	var gotCR map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		gotCR, _ = body["chatRequest"].(map[string]any)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"chatResponse": map[string]any{"apiFormat": "COHERE", "text": "bonjour", "finishReason": "COMPLETE"},
		})
	}))
	defer srv.Close()

	setOCIEnv(t, pemData)
	p, _ := api.NewProvider("oci", api.ProviderConfig{BaseURL: srv.URL})
	resp, err := p.Complete(context.Background(), &api.ChatRequest{
		Model: "cohere.command-r-plus",
		Messages: []api.Message{
			{Role: "system", Content: api.TextContent("speak french")},
			{Role: "assistant", Content: api.TextContent("salut")},
			{Role: "user", Content: api.TextContent("hello")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotCR["apiFormat"] != "COHERE" || gotCR["message"] != "hello" {
		t.Errorf("chatRequest = %v", gotCR)
	}
	if gotCR["preambleOverride"] != "speak french" {
		t.Errorf("preambleOverride = %v", gotCR["preambleOverride"])
	}
	history, _ := gotCR["chatHistory"].([]any)
	if len(history) != 1 {
		t.Errorf("chatHistory = %v (the final user turn must move to `message`)", gotCR["chatHistory"])
	}
	if got := resp.Choices[0].Message.Content.AsText(); got != "bonjour" {
		t.Errorf("content = %q", got)
	}
}

func TestOCICohereToolsRejected(t *testing.T) {
	_, pemData := testKey(t)
	setOCIEnv(t, pemData)
	p, _ := api.NewProvider("oci", api.ProviderConfig{BaseURL: "http://127.0.0.1:0"})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "cohere.command-r-plus",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
		Tools:    []api.Tool{{Type: "function", Function: api.ToolFunction{Name: "f"}}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrBadRequest {
		t.Fatalf("err = %v, want bad-request about cohere tools", err)
	}
}

func TestOCIMissingCredentials(t *testing.T) {
	for _, k := range []string{"OCI_USER", "OCI_FINGERPRINT", "OCI_TENANCY", "OCI_COMPARTMENT_ID", "OCI_KEY", "OCI_KEY_FILE"} {
		t.Setenv(k, "")
	}
	p, _ := api.NewProvider("oci", api.ProviderConfig{})
	_, err := p.Complete(context.Background(), &api.ChatRequest{
		Model:    "meta.llama-3.3-70b-instruct",
		Messages: []api.Message{{Role: "user", Content: api.TextContent("hi")}},
	})
	apiErr, ok := err.(*api.Error)
	if !ok || apiErr.Type != api.ErrAuthentication {
		t.Fatalf("err = %v, want authentication api.Error", err)
	}
}
