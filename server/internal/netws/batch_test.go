package netws

import (
	"bytes"
	"encoding/binary"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/wire"
)

func TestReliableBatchBoundsAndBarriers(t *testing.T) {
	frame := queuedFrame{data: []byte{frameDown, 1}}
	t.Run("count bound retains excess", func(t *testing.T) {
		queue := make(chan queuedFrame, wire.MaxBatchChildren+1)
		for range wire.MaxBatchChildren + 1 {
			queue <- frame
		}
		data, pending := collectReliableBatch(frame, queue, nil)
		if data[0] != wire.FrameBatch || binary.LittleEndian.Uint16(data[2:]) != wire.MaxBatchChildren || pending != nil || len(queue) != 2 {
			t.Fatalf("count bound: count=%d pending=%v remaining=%d", binary.LittleEndian.Uint16(data[2:]), pending, len(queue))
		}
	})
	t.Run("byte bound retains oversized next child", func(t *testing.T) {
		queue := make(chan queuedFrame, 2)
		large := queuedFrame{data: append([]byte{frameDown}, bytes.Repeat([]byte{1}, wire.MaxFrameBytes-10)...)}
		queue <- large
		queue <- frame
		data, pending := collectReliableBatch(frame, queue, nil)
		if !bytes.Equal(data, frame.data) || pending == nil || !bytes.Equal(pending.data, large.data) || len(queue) != 1 {
			t.Fatal("oversized child lost or reordered")
		}
	})
	for _, barrier := range []queuedFrame{{data: []byte{frameDown, 2}, bootstrap: true}, {data: []byte{framePong, 1}}, {snapshot: nil, data: []byte{wire.FrameSnapshot, 1}}} {
		queue := make(chan queuedFrame, 1)
		queue <- barrier
		data, pending := collectReliableBatch(frame, queue, nil)
		if !bytes.Equal(data, frame.data) || pending == nil || !bytes.Equal(pending.data, barrier.data) {
			t.Fatal("barrier must be retained outside the batch")
		}
	}
}

func TestReliableBatchDoesNotWaitForSimulationTick(t *testing.T) {
	start := time.Now()
	data, pending := collectReliableBatch(queuedFrame{data: []byte{frameDown, 1}}, make(chan queuedFrame), nil)
	if len(data) != 2 || pending != nil {
		t.Fatal("single child should remain unwrapped")
	}
	// Leave scheduling headroom on busy CI; the actual configured bound is 1 ms.
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("batch collection blocked")
	}
}

func TestOffersCompactProtocol(t *testing.T) {
	r := httptest.NewRequest("GET", "/ws", nil)
	r.Header.Add("Sec-WebSocket-Protocol", "other, omb.binary.v10")
	if OffersCompactProtocol(r) {
		t.Fatal("must match the complete token")
	}
	r.Header.Add("Sec-WebSocket-Protocol", "  "+wire.Subprotocol+" , other")
	if !OffersCompactProtocol(r) {
		t.Fatal("must handle multiple header lines and whitespace")
	}
}
