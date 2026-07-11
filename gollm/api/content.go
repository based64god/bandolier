package api

import (
	"encoding/json"
	"fmt"
	"strings"
)

// MessageContent is OpenAI's polymorphic message content: a plain string, an
// array of typed parts, or null (assistant messages that carry only tool
// calls). The zero value marshals as null.
type MessageContent struct {
	// Parts, when non-nil, is the array form and takes precedence.
	Parts []ContentPart
	// Text is the plain-string form.
	Text string
	// set records that a plain string was explicitly present — it
	// distinguishes an empty-string content (legal) from absent content.
	set bool
}

// Text returns string content: the plain form, or all text parts joined.
// Convenient for providers/backends that only accept flat strings.
func (c MessageContent) AsText() string {
	if c.Parts == nil {
		return c.Text
	}
	var b strings.Builder
	for _, p := range c.Parts {
		if p.Type == "text" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// IsZero reports whether the content is null on the wire.
func (c MessageContent) IsZero() bool {
	return c.Parts == nil && !c.set
}

// TextContent builds plain-string content (including the empty string).
func TextContent(s string) MessageContent {
	return MessageContent{Text: s, set: true}
}

// PartsContent builds array-form content.
func PartsContent(parts ...ContentPart) MessageContent {
	if parts == nil {
		parts = []ContentPart{}
	}
	return MessageContent{Parts: parts}
}

func (c MessageContent) MarshalJSON() ([]byte, error) {
	if c.Parts != nil {
		return json.Marshal(c.Parts)
	}
	if !c.set {
		return []byte("null"), nil
	}
	return json.Marshal(c.Text)
}

func (c *MessageContent) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	switch {
	case trimmed == "null":
		*c = MessageContent{}
		return nil
	case strings.HasPrefix(trimmed, "\""):
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		*c = MessageContent{Text: s, set: true}
		return nil
	case strings.HasPrefix(trimmed, "["):
		var parts []ContentPart
		if err := json.Unmarshal(data, &parts); err != nil {
			return err
		}
		if parts == nil {
			parts = []ContentPart{}
		}
		*c = MessageContent{Parts: parts}
		return nil
	default:
		return fmt.Errorf("message content must be a string, array, or null, got: %.40s", trimmed)
	}
}

// ContentPart is one element of array-form content. Only the fields matching
// Type are set.
type ContentPart struct {
	Type string `json:"type"` // text | image_url | input_audio | file

	Text     string      `json:"text,omitempty"`
	ImageURL *ImageURL   `json:"image_url,omitempty"`
	Audio    *InputAudio `json:"input_audio,omitempty"`
	File     *FilePart   `json:"file,omitempty"`
}

// ImageURL is an https URL or a data: URI (base64 inline image).
type ImageURL struct {
	URL    string `json:"url"`
	Detail string `json:"detail,omitempty"` // low | high | auto
}

type InputAudio struct {
	Data   string `json:"data"`   // base64
	Format string `json:"format"` // wav | mp3
}

type FilePart struct {
	FileID   string `json:"file_id,omitempty"`
	Filename string `json:"filename,omitempty"`
	FileData string `json:"file_data,omitempty"` // data: URI
}

// TextPart builds a text content part.
func TextPart(s string) ContentPart {
	return ContentPart{Type: "text", Text: s}
}

// ImagePart builds an image_url content part.
func ImagePart(url string) ContentPart {
	return ContentPart{Type: "image_url", ImageURL: &ImageURL{URL: url}}
}

// StringOrSlice is a wire value that may be a single string or an array of
// strings (OpenAI's stop, embedding input). It normalizes to a slice.
type StringOrSlice []string

func (s StringOrSlice) MarshalJSON() ([]byte, error) {
	switch len(s) {
	case 0:
		return []byte("null"), nil
	case 1:
		return json.Marshal(s[0])
	default:
		return json.Marshal([]string(s))
	}
}

func (s *StringOrSlice) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "null" {
		*s = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var one string
		if err := json.Unmarshal(data, &one); err != nil {
			return err
		}
		*s = StringOrSlice{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(data, &many); err != nil {
		return err
	}
	*s = many
	return nil
}

// ToolChoice models OpenAI's tool_choice: the strings "auto" | "none" |
// "required", or an object naming one function.
type ToolChoice struct {
	Mode string // auto | none | required | function | raw
	// FunctionName is set when Mode == "function".
	FunctionName string
	// raw preserves an object form gollm doesn't model (e.g. "allowed_tools",
	// "custom"), so Mode "raw" round-trips it back to the backend verbatim
	// rather than corrupting it into an empty function choice.
	raw json.RawMessage
}

// ToolChoiceAuto/None/Required/Function are convenience constructors.
func ToolChoiceAuto() *ToolChoice     { return &ToolChoice{Mode: "auto"} }
func ToolChoiceNone() *ToolChoice     { return &ToolChoice{Mode: "none"} }
func ToolChoiceRequired() *ToolChoice { return &ToolChoice{Mode: "required"} }
func ToolChoiceFunction(name string) *ToolChoice {
	return &ToolChoice{Mode: "function", FunctionName: name}
}

func (t ToolChoice) MarshalJSON() ([]byte, error) {
	if t.Mode == "raw" && len(t.raw) > 0 {
		return t.raw, nil
	}
	if t.Mode == "function" {
		return json.Marshal(map[string]any{
			"type":     "function",
			"function": map[string]string{"name": t.FunctionName},
		})
	}
	return json.Marshal(t.Mode)
}

func (t *ToolChoice) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "\"") {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		*t = ToolChoice{Mode: s}
		return nil
	}
	var obj struct {
		Type     string `json:"type"`
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	// Only the {"type":"function","function":{"name":...}} form maps onto a
	// named-function choice; any other object form (allowed_tools, custom, …)
	// is preserved verbatim so it reaches the backend intact.
	if obj.Type == "function" && obj.Function.Name != "" {
		*t = ToolChoice{Mode: "function", FunctionName: obj.Function.Name}
		return nil
	}
	*t = ToolChoice{Mode: "raw", raw: append(json.RawMessage(nil), data...)}
	return nil
}
