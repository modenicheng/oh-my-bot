package wire_test

import (
	"bytes"
	"encoding/binary"
	"math"
	"strings"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/wire"

	"google.golang.org/protobuf/proto"
)

func TestMalformedFrames(t *testing.T) {
	full := encode(t, wire.NewEncoder(), goldenSnapshot())
	mutate := func(offset int, values ...byte) []byte {
		b := bytes.Clone(full)
		copy(b[offset:], values)
		return b
	}
	cases := map[string][]byte{
		"empty": nil, "unknown type": {6}, "upstream": {2}, "ping": {0}, "pong": {1},
		"version": mutate(1, 2), "flags": mutate(2, 128), "sections": mutate(20, 0, 128),
		"entity mask": mutate(28, 255, 255), "missing required": mutate(28, 254, 7),
		"robot flags": mutate(40, 128), "invalid utf8": mutate(51, 255),
		"bad string length": mutate(49, 255, 255), "bad count": mutate(22, 255, 255),
		"trailing": append(bytes.Clone(full), 0), "oversized": make([]byte, wire.MaxFrameBytes+1),
		"batch version": {5, 2, 0, 0}, "batch count": {5, 1, 65, 0},
		"batch nested": batch(batch(full)), "batch ping": batch([]byte{0}),
		"batch zero length": {5, 1, 1, 0, 0, 0, 0, 0},
		"batch huge length": {5, 1, 1, 0, 255, 255, 255, 255},
		"batch trailing":    append(batch(full), 0), "protobuf malformed": {3, 10, 255},
	}
	// Each compact layout below isolates a value constraint, independently of the golden offsets.
	header := func(flags byte, sections uint16, tail ...byte) []byte {
		b := make([]byte, 22)
		b[0], b[1], b[2] = 4, 1, flags
		binary.LittleEndian.PutUint16(b[20:], sections)
		return append(b, tail...)
	}
	cases["self mask"] = header(3, 0, 0, 128)
	self := make([]byte, 16)
	binary.LittleEndian.PutUint16(self, 1)
	cases["self boolean"] = header(3, 0, append(bytes.Clone(self), 2)...)
	binary.LittleEndian.PutUint16(self, 1<<6)
	self = binary.LittleEndian.AppendUint32(self, 0)
	self = append(self, 6)
	cases["upgrade count"] = header(3, 0, self...)
	self[len(self)-1] = 1
	cases["upgrade level"] = header(3, 0, append(self, 11)...)
	cases["health boolean"] = header(1, 1<<8, 1, 0, 1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 2, 0, 0)
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			if msgs, err := wire.NewDecoder().DecodeFrame(b); err == nil || len(msgs) != 0 {
				t.Fatalf("malformed frame accepted: %x", b)
			}
		})
	}
	// Syntactically invalid gaps are errors, not header-only resync notifications.
	d := wire.NewDecoder()
	decode(t, d, full)
	badGap := mutate(7, 99, 0, 0, 0)
	badGap[2] &^= 1
	badGap = append(badGap, 0)
	if _, err := d.DecodeFrame(badGap); err == nil {
		t.Fatal("malformed gap accepted")
	}
}

func TestEncodeErrorsDoNotCommit(t *testing.T) {
	cases := map[string]func(*ombv1.SnapshotDelta){
		"coordinate overflow":      func(s *ombv1.SnapshotDelta) { s.Robots[0].Base.Pos.X = 327.68 },
		"coordinate underflow":     func(s *ombv1.SnapshotDelta) { s.Robots[0].Base.Pos.Y = -327.69 },
		"nan":                      func(s *ombv1.SnapshotDelta) { s.Robots[0].Base.Pos.X = math.NaN() },
		"inf heading":              func(s *ombv1.SnapshotDelta) { s.Projectiles[0].Base.Heading = float32(math.Inf(1)) },
		"hp overflow":              func(s *ombv1.SnapshotDelta) { s.Robots[0].HpX10 = 32768 },
		"energy underflow":         func(s *ombv1.SnapshotDelta) { s.Robots[0].EnergyX10 = -32769 },
		"optional hp overflow":     func(s *ombv1.SnapshotDelta) { s.Robots[0].MaxHpX10 = ptr(int32(32768)) },
		"respawn overflow":         func(s *ombv1.SnapshotDelta) { s.Robots[0].RespawnInS = 65536 },
		"invulnerability overflow": func(s *ombv1.SnapshotDelta) { s.Robots[0].InvulnS = ptr(uint32(65536)) },
		"phase overflow":           func(s *ombv1.SnapshotDelta) { s.Phase = 256 },
		"utf8":                     func(s *ombv1.SnapshotDelta) { s.Robots[0].Nick = "\xff" },
		"string overflow":          func(s *ombv1.SnapshotDelta) { s.Robots[0].Nick = strings.Repeat("x", 65536) },
		"frame overflow":           func(s *ombv1.SnapshotDelta) { s.Robots[0].Nick = strings.Repeat("x", 65535) },
		"radius overflow":          func(s *ombv1.SnapshotDelta) { s.VisionRadius = ptr(655.36) },
		"radius negative":          func(s *ombv1.SnapshotDelta) { s.VisionRadius = ptr(-1.0) },
		"radius nan":               func(s *ombv1.SnapshotDelta) { s.VisionRadius = ptr(math.NaN()) },
		"source overflow":          func(s *ombv1.SnapshotDelta) { s.Self.MoveSrc = -1 },
		"upgrade count":            func(s *ombv1.SnapshotDelta) { s.Self.Upgrade.Levels = make([]uint32, 6) },
		"upgrade level":            func(s *ombv1.SnapshotDelta) { s.Self.Upgrade.Levels[0] = 11 },
		"nil robot":                func(s *ombv1.SnapshotDelta) { s.Robots[0] = nil },
		"nil base":                 func(s *ombv1.SnapshotDelta) { s.Robots[0].Base = nil },
		"nil position":             func(s *ombv1.SnapshotDelta) { s.Robots[0].Base.Pos = nil },
		"gone count":               func(s *ombv1.SnapshotDelta) { s.RobotGone = make([]uint32, 65536) },
		"entity count":             func(s *ombv1.SnapshotDelta) { s.Robots = make([]*ombv1.RobotState, 65536) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			e, reference := wire.NewEncoder(), wire.NewEncoder()
			s := goldenSnapshot()
			encode(t, e, s)
			encode(t, reference, s)
			s.Tick, s.BaseTick, s.Full = 101, 100, false
			s.Robots[0].HpX10 = 42
			bad := proto.Clone(s).(*ombv1.SnapshotDelta)
			mutate(bad)
			if frame, err := e.EncodeSnapshot(bad); err == nil || len(frame) != 0 {
				t.Fatal("invalid source accepted")
			}
			if got, want := encode(t, e, s), encode(t, reference, s); !bytes.Equal(got, want) {
				t.Fatalf("failed encode committed state\ngot %x\nwant %x", got, want)
			}
		})
	}
	if frame, err := wire.NewEncoder().EncodeSnapshot(nil); err == nil || len(frame) != 0 {
		t.Fatal("nil snapshot accepted")
	}
}
