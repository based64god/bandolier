package bedrock

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"io"
	"strings"
	"testing"
)

// wrapFrame adds the prelude and both CRCs around a raw header block and
// payload.
func wrapFrame(headerBytes, payload []byte) []byte {
	var buf bytes.Buffer
	total := 12 + len(headerBytes) + len(payload) + 4
	binary.Write(&buf, binary.BigEndian, uint32(total))
	binary.Write(&buf, binary.BigEndian, uint32(len(headerBytes)))
	binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(buf.Bytes()))
	buf.Write(headerBytes)
	buf.Write(payload)
	binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(buf.Bytes()))
	return buf.Bytes()
}

// encodeFrame builds one frame with string-typed headers in the given order.
func encodeFrame(headers [][2]string, payload []byte) []byte {
	var h bytes.Buffer
	for _, kv := range headers {
		h.WriteByte(byte(len(kv[0])))
		h.WriteString(kv[0])
		h.WriteByte(hdrString)
		binary.Write(&h, binary.BigEndian, uint16(len(kv[1])))
		h.WriteString(kv[1])
	}
	return wrapFrame(h.Bytes(), payload)
}

// eventFrame builds a Bedrock event frame with a JSON payload.
func eventFrame(eventType, payload string) []byte {
	return encodeFrame([][2]string{
		{":message-type", "event"},
		{":event-type", eventType},
		{":content-type", "application/json"},
	}, []byte(payload))
}

func TestEventStreamRoundTrip(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(eventFrame("messageStart", `{"role":"assistant"}`))
	stream.Write(eventFrame("messageStop", `{"stopReason":"end_turn"}`))

	r := newEventStreamReader(&stream)

	first, err := r.next()
	if err != nil {
		t.Fatalf("first frame: %v", err)
	}
	if first.headers[":event-type"] != "messageStart" || first.headers[":message-type"] != "event" {
		t.Errorf("first headers = %v", first.headers)
	}
	if string(first.payload) != `{"role":"assistant"}` {
		t.Errorf("first payload = %q", first.payload)
	}

	second, err := r.next()
	if err != nil {
		t.Fatalf("second frame: %v", err)
	}
	if second.headers[":event-type"] != "messageStop" {
		t.Errorf("second headers = %v", second.headers)
	}

	if _, err := r.next(); err != io.EOF {
		t.Errorf("want io.EOF at stream end, got %v", err)
	}
}

func TestEventStreamPreludeCRCMismatch(t *testing.T) {
	frame := eventFrame("messageStart", `{}`)
	frame[8] ^= 0xff // corrupt the prelude CRC
	_, err := newEventStreamReader(bytes.NewReader(frame)).next()
	if err == nil || !strings.Contains(err.Error(), "prelude CRC") {
		t.Errorf("want prelude CRC error, got %v", err)
	}
}

func TestEventStreamMessageCRCMismatch(t *testing.T) {
	frame := eventFrame("messageStart", `{"role":"assistant"}`)
	frame[len(frame)-1] ^= 0xff // corrupt the message CRC
	_, err := newEventStreamReader(bytes.NewReader(frame)).next()
	if err == nil || !strings.Contains(err.Error(), "message CRC") {
		t.Errorf("want message CRC error, got %v", err)
	}
}

func TestEventStreamTruncatedFrame(t *testing.T) {
	frame := eventFrame("messageStart", `{"role":"assistant"}`)
	_, err := newEventStreamReader(bytes.NewReader(frame[:len(frame)/2])).next()
	if err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Errorf("want truncation error, got %v", err)
	}
}

// TestEventStreamSkipsNonStringHeaders proves fixed-size and byte-buffer
// header values are length-skipped without desyncing the string headers
// around them.
func TestEventStreamSkipsNonStringHeaders(t *testing.T) {
	var h bytes.Buffer
	// bool true header (no value bytes)
	h.WriteByte(2)
	h.WriteString(":b")
	h.WriteByte(hdrTrue)
	// int32 header
	h.WriteByte(2)
	h.WriteString(":i")
	h.WriteByte(hdrInt)
	h.Write([]byte{0, 0, 0, 42})
	// string header that must survive the skips
	h.WriteByte(11)
	h.WriteString(":event-type")
	h.WriteByte(hdrString)
	binary.Write(&h, binary.BigEndian, uint16(len("metadata")))
	h.WriteString("metadata")

	frame := wrapFrame(h.Bytes(), []byte(`{}`))
	msg, err := newEventStreamReader(bytes.NewReader(frame)).next()
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if msg.headers[":event-type"] != "metadata" {
		t.Errorf("headers = %v, want :event-type=metadata", msg.headers)
	}
	if _, ok := msg.headers[":i"]; ok {
		t.Errorf("non-string header should not be surfaced: %v", msg.headers)
	}
}
