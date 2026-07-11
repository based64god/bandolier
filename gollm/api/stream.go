package api

import (
	"io"
	"sort"
)

// ChatStream yields streamed chunks. Recv returns io.EOF after the final
// chunk; any other error is terminal. Close releases the underlying
// connection and is safe to call at any point (including mid-stream to
// abandon it).
type ChatStream interface {
	Recv() (*ChatChunk, error)
	Close() error
}

// chunkFunc adapts a receive function (+closer) into a ChatStream.
type chunkFunc struct {
	recv  func() (*ChatChunk, error)
	close func() error
}

func (c *chunkFunc) Recv() (*ChatChunk, error) { return c.recv() }
func (c *chunkFunc) Close() error {
	if c.close == nil {
		return nil
	}
	return c.close()
}

// StreamFunc builds a ChatStream from a receive function and optional closer.
func StreamFunc(recv func() (*ChatChunk, error), close func() error) ChatStream {
	return &chunkFunc{recv: recv, close: close}
}

// SliceStream replays pre-built chunks; useful in tests and for buffered
// re-streaming.
func SliceStream(chunks []*ChatChunk) ChatStream {
	i := 0
	return StreamFunc(func() (*ChatChunk, error) {
		if i >= len(chunks) {
			return nil, io.EOF
		}
		c := chunks[i]
		i++
		return c, nil
	}, nil)
}

// StreamAccumulator folds chunks into a complete ChatResponse — litellm's
// stream_chunk_builder. Tool-call argument fragments are stitched by delta
// index; the last non-empty finish_reason and the last usage win.
type StreamAccumulator struct {
	id      string
	model   string
	created int64
	usage   *Usage

	choices map[int]*accChoice
}

type accChoice struct {
	role         string
	content      []byte
	reasoning    []byte
	finishReason string
	toolCalls    map[int]*accToolCall
	// artificialIdx assigns synthetic indices to tool calls from providers
	// that stream whole calls without an index; curArtificial is the one
	// currently accumulating argument bytes.
	artificialIdx int
	curArtificial int
}

type accToolCall struct {
	id   string
	typ  string
	name string
	args []byte
}

func NewStreamAccumulator() *StreamAccumulator {
	return &StreamAccumulator{choices: map[int]*accChoice{}}
}

// Add folds one chunk in.
func (a *StreamAccumulator) Add(chunk *ChatChunk) {
	if chunk == nil {
		return
	}
	if chunk.ID != "" {
		a.id = chunk.ID
	}
	if chunk.Model != "" {
		a.model = chunk.Model
	}
	if chunk.Created != 0 {
		a.created = chunk.Created
	}
	if chunk.Usage != nil {
		a.usage = chunk.Usage
	}
	for _, cc := range chunk.Choices {
		ch := a.choices[cc.Index]
		if ch == nil {
			ch = &accChoice{toolCalls: map[int]*accToolCall{}}
			a.choices[cc.Index] = ch
		}
		if cc.Delta.Role != "" {
			ch.role = cc.Delta.Role
		}
		ch.content = append(ch.content, cc.Delta.Content...)
		ch.reasoning = append(ch.reasoning, cc.Delta.ReasoningContent...)
		if cc.FinishReason != "" {
			ch.finishReason = cc.FinishReason
		}
		if ch.toolCalls == nil {
			ch.toolCalls = map[int]*accToolCall{}
		}
		for _, tc := range cc.Delta.ToolCalls {
			// OpenAI correlates streamed fragments by index. When a provider
			// omits it (some compat backends stream one whole call per delta),
			// a fragment that carries a fresh id or name starts a NEW call;
			// otherwise it continues the current one. Keying every index-less
			// fragment to 0 would merge distinct calls into one with
			// concatenated arguments.
			var idx int
			if tc.Index != nil {
				idx = *tc.Index
			} else {
				if tc.ID != "" || tc.Function.Name != "" {
					ch.curArtificial = ch.artificialIdx
					ch.artificialIdx++
				}
				idx = ch.curArtificial
			}
			acc := ch.toolCalls[idx]
			if acc == nil {
				acc = &accToolCall{}
				ch.toolCalls[idx] = acc
			}
			if tc.ID != "" {
				acc.id = tc.ID
			}
			if tc.Type != "" {
				acc.typ = tc.Type
			}
			if tc.Function.Name != "" {
				acc.name = tc.Function.Name
			}
			acc.args = append(acc.args, tc.Function.Arguments...)
		}
	}
}

// Response builds the accumulated ChatResponse.
func (a *StreamAccumulator) Response() *ChatResponse {
	resp := &ChatResponse{
		ID:      a.id,
		Object:  "chat.completion",
		Created: a.created,
		Model:   a.model,
		Usage:   a.usage,
	}

	idxs := make([]int, 0, len(a.choices))
	for i := range a.choices {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)

	for _, i := range idxs {
		ch := a.choices[i]
		msg := Message{Role: ch.role, ReasoningContent: string(ch.reasoning)}
		if msg.Role == "" {
			msg.Role = "assistant"
		}
		if len(ch.content) > 0 {
			msg.Content = TextContent(string(ch.content))
		}

		tcIdxs := make([]int, 0, len(ch.toolCalls))
		for ti := range ch.toolCalls {
			tcIdxs = append(tcIdxs, ti)
		}
		sort.Ints(tcIdxs)
		for _, ti := range tcIdxs {
			tc := ch.toolCalls[ti]
			typ := tc.typ
			if typ == "" {
				typ = "function"
			}
			msg.ToolCalls = append(msg.ToolCalls, ToolCall{
				ID:   tc.id,
				Type: typ,
				Function: ToolCallFunction{
					Name:      tc.name,
					Arguments: string(tc.args),
				},
			})
		}

		finish := ch.finishReason
		if finish == "" {
			finish = "stop"
		}
		resp.Choices = append(resp.Choices, Choice{
			Index:        i,
			Message:      msg,
			FinishReason: finish,
		})
	}
	return resp
}
