package api

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
)

// EmbeddingRequest is a unified embeddings request in OpenAI wire format.
type EmbeddingRequest struct {
	Model string `json:"model"`
	// Input is one string or many; token-array inputs are not modeled.
	Input          StringOrSlice `json:"input"`
	EncodingFormat string        `json:"encoding_format,omitempty"` // float | base64
	Dimensions     *int          `json:"dimensions,omitempty"`
	User           string        `json:"user,omitempty"`

	// Routing/transport overrides, as on ChatRequest.
	APIKey  string            `json:"-"`
	BaseURL string            `json:"-"`
	Headers map[string]string `json:"-"`
}

// EmbeddingResponse is OpenAI's embeddings list envelope.
type EmbeddingResponse struct {
	Object string      `json:"object"` // "list"
	Data   []Embedding `json:"data"`
	Model  string      `json:"model"`
	Usage  *Usage      `json:"usage,omitempty"`
}

type Embedding struct {
	Object    string          `json:"object"` // "embedding"
	Index     int             `json:"index"`
	Embedding EmbeddingVector `json:"embedding"`
}

// EmbeddingVector is an embedding that decodes from either wire form: a JSON
// array of numbers (encoding_format "float", the default in this SDK) or a
// base64 string of packed little-endian float32 (encoding_format "base64",
// which the openai-python client requests by default). Without this, a
// base64-format response fails to decode and the call 502s.
type EmbeddingVector []float64

func (v *EmbeddingVector) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "null" {
		*v = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var floats []float64
		if err := json.Unmarshal(data, &floats); err != nil {
			return err
		}
		*v = floats
		return nil
	}
	var b64 string
	if err := json.Unmarshal(data, &b64); err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return err
	}
	out := make([]float64, len(raw)/4)
	for i := range out {
		bits := binary.LittleEndian.Uint32(raw[i*4:])
		out[i] = float64(math.Float32frombits(bits))
	}
	*v = out
	return nil
}
