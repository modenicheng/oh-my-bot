package netws

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/wire"
)

func binarySay(text string) *ombv1.ServerMsg {
	return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Text: text}},
	}}}
}

func TestBinaryNegotiatesAndBatchesReliableEvents(t *testing.T) {
	h := Handler(func(reliable, _ func(*ombv1.ServerMsg), _ func([]byte), closeConn func()) func(*ombv1.ClientMsg) {
		for _, text := range []string{"one", "two", "three"} {
			reliable(binarySay(text))
		}
		closeConn()
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(s), &websocket.DialOptions{Subprotocols: []string{wire.Subprotocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if c.Subprotocol() != wire.Subprotocol {
		t.Fatalf("binary protocol not negotiated: %q", c.Subprotocol())
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if data[0] != wire.FrameBatch {
		t.Fatalf("three queued events should use one WS batch: %x", data)
	}
	messages, err := wire.NewDecoder().DecodeFrame(data)
	if err != nil || len(messages) != 3 {
		t.Fatalf("decode batch: messages=%d err=%v", len(messages), err)
	}
	for i, text := range []string{"one", "two", "three"} {
		if got := messages[i].GetEvent().GetSay().GetText(); got != text {
			t.Fatalf("event %d = %q, want %q", i, got, text)
		}
	}
}

func TestBinaryBootstrapBarrierAndWriterSnapshotOrder(t *testing.T) {
	bootstrap := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapJson: "{}"}},
	}}}
	snap := func(tick, base uint32, full bool) *ombv1.ServerMsg {
		return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{
			Tick: tick, BaseTick: base, Full: full, Phase: ombv1.Phase_OUTER_RING, TimeLeftS: 480,
		}}}
	}
	h := Handler(func(reliable, lossy func(*ombv1.ServerMsg), _ func([]byte), closeConn func()) func(*ombv1.ClientMsg) {
		lossy(snap(900, 899, false))
		reliable(bootstrap)
		lossy(snap(2, 1, false))
		reliable(snap(3, 0, true))
		lossy(snap(4, 3, false))
		closeConn()
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(s), &websocket.DialOptions{Subprotocols: []string{wire.Subprotocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	dec := wire.NewDecoder()
	var ticks []uint32
	bootstrapSeen := false
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			break
		}
		messages, err := dec.DecodeFrame(data)
		if err != nil {
			t.Fatal(err)
		}
		for _, message := range messages {
			if message.GetEvent().GetMapBootstrap() != nil {
				bootstrapSeen = true
				if data[0] == wire.FrameBatch {
					t.Fatal("bootstrap must remain a batch barrier")
				}
			}
			if snapshot := message.GetSnapshot(); snapshot != nil {
				if !bootstrapSeen || data[0] != wire.FrameSnapshot {
					t.Fatal("compact snapshot must follow its bootstrap")
				}
				ticks = append(ticks, snapshot.Tick)
			}
		}
	}
	if len(ticks) != 2 || ticks[0] != 3 || ticks[1] != 4 {
		t.Fatalf("obsolete snapshots leaked through full barrier: %v", ticks)
	}
}

func TestBinaryPausedResyncAllowsSameTickFull(t *testing.T) {
	h := Handler(func(reliable, _ func(*ombv1.ServerMsg), _ func([]byte), closeConn func()) func(*ombv1.ClientMsg) {
		for range 2 {
			reliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{Tick: 7, Full: true, TimeLeftS: 86400}}})
		}
		closeConn()
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(s), &websocket.DialOptions{Subprotocols: []string{wire.Subprotocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	decoder := wire.NewDecoder()
	for range 2 {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		msgs, err := decoder.DecodeFrame(data)
		if err != nil || len(msgs) != 1 || !msgs[0].GetSnapshot().GetFull() || msgs[0].GetSnapshot().GetTick() != 7 {
			t.Fatalf("same-tick full was suppressed: messages=%v err=%v", msgs, err)
		}
	}
}

func TestLegacyClientRetainsIndividualProtobufFrames(t *testing.T) {
	h := Handler(func(reliable, _ func(*ombv1.ServerMsg), _ func([]byte), closeConn func()) func(*ombv1.ClientMsg) {
		reliable(binarySay("one"))
		reliable(binarySay("two"))
		closeConn()
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(s), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if c.Subprotocol() != "" {
		t.Fatal("legacy connection must not opt into compact encoding")
	}
	decoder := wire.NewDecoder()
	for _, want := range []string{"one", "two"} {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		msgs, err := decoder.DecodeFrame(data)
		if err != nil || data[0] != frameDown || len(msgs) != 1 || msgs[0].GetEvent().GetSay().GetText() != want {
			t.Fatalf("legacy wire changed: frame=%x err=%v", data, err)
		}
	}
}
