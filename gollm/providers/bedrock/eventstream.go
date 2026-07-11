package bedrock

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
)

// AWS eventstream binary framing (application/vnd.amazon.eventstream):
//
//	prelude:  4B total length | 4B headers length | 4B CRC32(first 8 bytes)
//	headers:  repeated { 1B name len | name | 1B value type | value }
//	payload:  total − headers − 16 bytes
//	trailer:  4B CRC32(everything before it)
//
// Integers are big-endian; both CRCs use the IEEE polynomial and are
// validated — a mismatch means the stream is corrupt, not recoverable.

// maxFrameSize rejects garbage length words before allocating; AWS caps
// eventstream messages well below this.
const maxFrameSize = 16 << 20

// Header value types from the eventstream spec. Bedrock only sends type 7
// (string), but every type is length-skipped so an unexpected header can't
// desync the frame.
const (
	hdrTrue = iota
	hdrFalse
	hdrByte
	hdrShort
	hdrInt
	hdrLong
	hdrByteBuf
	hdrString
	hdrTimestamp
	hdrUUID
)

var crcTable = crc32.MakeTable(crc32.IEEE)

// eventMessage is one decoded frame: its string-typed headers (":event-type",
// ":message-type", ...) and JSON payload.
type eventMessage struct {
	headers map[string]string
	payload []byte
}

type eventStreamReader struct {
	r io.Reader
}

func newEventStreamReader(r io.Reader) *eventStreamReader {
	return &eventStreamReader{r: bufio.NewReaderSize(r, 32<<10)}
}

// next reads and validates one frame; io.EOF signals a clean stream end.
func (e *eventStreamReader) next() (*eventMessage, error) {
	var prelude [12]byte
	if _, err := io.ReadFull(e.r, prelude[:]); err != nil {
		if err == io.ErrUnexpectedEOF {
			return nil, fmt.Errorf("eventstream: truncated prelude")
		}
		return nil, err
	}
	total := binary.BigEndian.Uint32(prelude[0:4])
	headerLen := binary.BigEndian.Uint32(prelude[4:8])
	if crc32.Checksum(prelude[:8], crcTable) != binary.BigEndian.Uint32(prelude[8:12]) {
		return nil, fmt.Errorf("eventstream: prelude CRC mismatch")
	}
	if total < 16 || total > maxFrameSize || headerLen > total-16 {
		return nil, fmt.Errorf("eventstream: invalid frame lengths (total=%d headers=%d)", total, headerLen)
	}

	rest := make([]byte, total-12)
	if _, err := io.ReadFull(e.r, rest); err != nil {
		return nil, fmt.Errorf("eventstream: truncated frame: %w", err)
	}
	body, trailer := rest[:len(rest)-4], rest[len(rest)-4:]
	crc := crc32.Update(crc32.Checksum(prelude[:], crcTable), crcTable, body)
	if crc != binary.BigEndian.Uint32(trailer) {
		return nil, fmt.Errorf("eventstream: message CRC mismatch")
	}

	headers, err := parseEventHeaders(body[:headerLen])
	if err != nil {
		return nil, err
	}
	return &eventMessage{headers: headers, payload: body[headerLen:]}, nil
}

// parseEventHeaders decodes the header block, keeping string-typed values.
func parseEventHeaders(b []byte) (map[string]string, error) {
	h := map[string]string{}
	for len(b) > 0 {
		nameLen := int(b[0])
		b = b[1:]
		if len(b) < nameLen+1 {
			return nil, fmt.Errorf("eventstream: truncated header name")
		}
		name := string(b[:nameLen])
		typ := b[nameLen]
		b = b[nameLen+1:]

		var size int
		switch typ {
		case hdrTrue, hdrFalse:
			size = 0
		case hdrByte:
			size = 1
		case hdrShort:
			size = 2
		case hdrInt:
			size = 4
		case hdrLong, hdrTimestamp:
			size = 8
		case hdrUUID:
			size = 16
		case hdrByteBuf, hdrString:
			if len(b) < 2 {
				return nil, fmt.Errorf("eventstream: truncated header value length")
			}
			size = int(binary.BigEndian.Uint16(b))
			b = b[2:]
		default:
			return nil, fmt.Errorf("eventstream: unknown header value type %d", typ)
		}
		if len(b) < size {
			return nil, fmt.Errorf("eventstream: truncated header value")
		}
		if typ == hdrString {
			h[name] = string(b[:size])
		}
		b = b[size:]
	}
	return h, nil
}
