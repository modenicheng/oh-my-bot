package wire_test

import (
	"fmt"
	"strings"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/wire"
	"google.golang.org/protobuf/proto"
)

func scriptHistory(versions int, source string) *ombv1.ServerMsg {
	history := &ombv1.EvScriptVersions{CurrentId: uint32(versions)}
	for i := 0; i < versions; i++ {
		history.Versions = append(history.Versions, &ombv1.EvScriptVersion{Id: uint32(i + 1), Source: source})
	}
	return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ScriptVersions{ScriptVersions: history},
	}}}
}

func scriptHistoryFrameOfSize(t testing.TB, size int) []byte {
	t.Helper()
	msg := scriptHistory(1, strings.Repeat("s", size))
	version := msg.GetEvent().GetScriptVersions().Versions[0]
	overhead := 1 + proto.Size(msg) - size
	version.Source = version.Source[:size-overhead]
	frame := protobuf(t, msg)
	if len(frame) != size {
		t.Fatalf("control fixture size = %d, want %d", len(frame), size)
	}
	return frame
}

func TestLargeProtobufScriptHistoryPreservesCompactBaseline(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	s := goldenSnapshot()
	decode(t, d, encode(t, e, s))
	history := scriptHistory(32, strings.Repeat("s", 4096))
	frame := protobuf(t, history)
	if len(frame) <= wire.MaxFrameBytes {
		t.Fatal("fixture must exceed compact-frame limit")
	}
	got := decode(t, d, frame)
	if len(got) != 1 || !proto.Equal(got[0], history) {
		t.Fatal("large script history changed")
	}
	s.Full, s.Tick, s.BaseTick, s.Robots[0].HpX10 = false, 101, 100, 0
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); len(got.Robots) != 1 || got.Robots[0].HpX10 != 0 {
		t.Fatal("large control frame changed compact baseline")
	}
}

func TestControlAndCompactFrameSizeLimits(t *testing.T) {
	for _, size := range []int{wire.MaxFrameBytes + 1, (8 << 20) + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			frame := scriptHistoryFrameOfSize(t, size)
			got := decode(t, wire.NewDecoder(), frame)
			if len(got) != 1 || len(got[0].GetEvent().GetScriptVersions().Versions) != 1 {
				t.Fatal("valid standalone control frame rejected")
			}
			if msgs, err := wire.NewDecoder().DecodeFrame(batch(frame)); err == nil || len(msgs) != 0 {
				t.Fatal("large control child bypassed batch outer limit")
			}
		})
	}
	// A valid protobuf child can fill an outer batch up to, but not beyond, 64 KiB.
	for _, size := range []int{wire.MaxFrameBytes, wire.MaxFrameBytes + 1} {
		frame := batch(scriptHistoryFrameOfSize(t, size-8))
		msgs, err := wire.NewDecoder().DecodeFrame(frame)
		if size == wire.MaxFrameBytes {
			if err != nil || len(msgs) != 1 {
				t.Fatalf("exact maximum batch rejected: %v", err)
			}
		} else if err == nil || len(msgs) != 0 {
			t.Fatal("batch above 64 KiB accepted")
		}
	}
	for _, frameType := range []byte{wire.FrameSnapshot, wire.FrameBatch} {
		frame := make([]byte, wire.MaxFrameBytes+1)
		frame[0], frame[1] = frameType, 1
		if msgs, err := wire.NewDecoder().DecodeFrame(frame); err == nil || len(msgs) != 0 {
			t.Fatalf("oversized type %d accepted", frameType)
		}
	}
}

func TestLargeProtobufFullResetIsAtomic(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	s := goldenSnapshot()
	decode(t, d, encode(t, e, s))
	// Legacy protobuf fulls share the unrestricted standalone frame policy, but
	// a malformed message must not commit its baseline reset regardless of size.
	reset := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{
		Full: true, MapJson: ptr(strings.Repeat("x", 8<<20)),
	}}}
	frame := protobuf(t, reset)
	if len(frame) <= 8<<20 {
		t.Fatal("fixture must exceed the former control cap")
	}
	if msgs, err := d.DecodeFrame(frame[:len(frame)-1]); err == nil || len(msgs) != 0 {
		t.Fatal("malformed large protobuf full accepted")
	}
	s.Full, s.Tick, s.BaseTick, s.Robots[0].HpX10 = false, 101, 100, 0
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); len(got.Robots) != 1 {
		t.Fatal("malformed control committed a reset")
	}
	if got := decode(t, d, frame); len(got) != 1 || !proto.Equal(got[0], reset) {
		t.Fatal("valid large protobuf full rejected or changed")
	}
	s.Tick, s.BaseTick = 102, 101
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); len(got.Robots) != 0 {
		t.Fatal("valid large protobuf full did not reset compact baseline")
	}
}
