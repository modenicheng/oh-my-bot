package wire_test

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"math"
	"os"
	"strings"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/wire"

	"google.golang.org/protobuf/proto"
)

func ptr[T any](v T) *T { return &v }

func base(id uint32, x, y float64, heading float32) *ombv1.EntityBase {
	return &ombv1.EntityBase{Id: id, Pos: &ombv1.Vec2{X: x, Y: y}, Heading: heading}
}

func goldenSnapshot() *ombv1.SnapshotDelta {
	return &ombv1.SnapshotDelta{
		Tick: 100, AckSeq: 7, Phase: ombv1.Phase_OUTER_RING, TimeLeftS: 300, Full: true,
		Robots: []*ombv1.RobotState{{Base: base(1, -1.25, 2.5, math.Pi/2), HpX10: 1000,
			ShieldOn: true, Dead: true, Nick: "Bot", Color: "#abc", InvulnS: ptr(uint32(0)),
			MaxHpX10: ptr(int32(1200)), MaxEnergyX10: ptr(int32(0))}},
		Projectiles: []*ombv1.ProjectileState{{Base: base(2, 0, -2, -math.Pi/2), OwnerId: 1, Color: "#abc"}},
		Cores:       []*ombv1.CoreState{{Base: base(3, 0, 0, 0), Value: -10}},
		Uplinks:     []*ombv1.UplinkState{{Base: base(4, 1, -1, 0)}},
		HealthPacks: []*ombv1.HealthPackState{{Base: base(5, 2, -2, 0), Available: true}},
		PointDrops:  []*ombv1.PointDropState{{Base: base(6, -.125, .125, 0), Points: 42}},
		Self: &ombv1.SelfState{RobotId: 1, MoveSrc: 1, TurretSrc: 2, AiRoundsLeft: 3, AiTokensLeftK: 4,
			AssistOn: ptr(false), DashReadyTick: ptr(uint32(0)), FireReadyTick: ptr(uint32(10)),
			FireSrc: ptr(ombv1.ControlSource(0)), AbilitySrc: ptr(ombv1.ControlSource(3)),
			ManualAxesMask: ptr(uint32(0)), Upgrade: &ombv1.UpgradeSelf{Points: 5, Levels: []uint32{0, 1, 10, 0, 2}},
			ShieldReadyTick: ptr(uint32(20)), ShieldStartedTick: ptr(uint32(0)), InputGeneration: ptr(uint32(9))},
		VisionRadius: ptr(20.0), MapJson: ptr("not transmitted"),
	}
}

func encode(t testing.TB, e *wire.Encoder, s *ombv1.SnapshotDelta) []byte {
	t.Helper()
	b, err := e.EncodeSnapshot(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func decode(t testing.TB, d *wire.Decoder, b []byte) []*ombv1.ServerMsg {
	t.Helper()
	m, err := d.DecodeFrame(b)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func protobuf(t testing.TB, m *ombv1.ServerMsg) []byte {
	t.Helper()
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte{3}, b...)
}

func batch(children ...[]byte) []byte {
	b := []byte{5, 1, 0, 0}
	binary.LittleEndian.PutUint16(b[2:], uint16(len(children)))
	for _, child := range children {
		b = binary.LittleEndian.AppendUint32(b, uint32(len(child)))
		b = append(b, child...)
	}
	return b
}

func TestGoldenSnapshot(t *testing.T) {
	if wire.Subprotocol != "omb.binary.v1" || wire.FrameSnapshot != 4 || wire.FrameBatch != 5 || wire.MaxFrameBytes != 65536 || wire.MaxBatchChildren != 64 {
		t.Fatal("public wire constants changed")
	}
	text, err := os.ReadFile("testdata/snapshot-v1.hex")
	if err != nil {
		t.Fatal(err)
	}
	want, err := hex.DecodeString(strings.Join(strings.Fields(string(text)), ""))
	if err != nil {
		t.Fatal(err)
	}
	got := encode(t, wire.NewEncoder(), goldenSnapshot())
	if !bytes.Equal(got, want) {
		t.Fatalf("golden mismatch\ngot  %x\nwant %x", got, want)
	}
	t.Logf("shared TS fixture snapshot-v1.hex (%d bytes): %x", len(got), got)
	s := decode(t, wire.NewDecoder(), want)[0].GetSnapshot()
	if s.Tick != 100 || !s.Full || len(s.Robots) != 1 || len(s.Projectiles) != 1 || len(s.Cores) != 1 || len(s.Uplinks) != 1 || len(s.HealthPacks) != 1 || len(s.PointDrops) != 1 {
		t.Fatalf("incorrect entity sections: %v", s)
	}
	if s.Robots[0].Base.Pos.X != -1.25 || s.PointDrops[0].Base.Pos.X != -.13 || s.PointDrops[0].Base.Pos.Y != .13 || s.Cores[0].Value != -10 || s.MapJson != nil {
		t.Fatalf("incorrect quantization/map suppression: %v", s)
	}
	if !proto.Equal(s.Self, goldenSnapshot().Self) || s.VisionRadius == nil || *s.VisionRadius != 20 {
		t.Fatalf("incorrect private state: %v", s)
	}
	if s.Robots[0].InvulnS == nil || *s.Robots[0].InvulnS != 0 || s.Robots[0].MaxEnergyX10 == nil || *s.Robots[0].MaxEnergyX10 != 0 {
		t.Fatal("optional zero lost")
	}
}

func TestQuantizedDeltaHydratesAndOmitsUnchanged(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	s := goldenSnapshot()
	decode(t, d, encode(t, e, s))
	s.Full, s.Tick, s.BaseTick = false, 101, 100
	s.Robots[0].Base.Pos.X += .001
	s.Robots[0].Nick, s.Robots[0].Color = "", ""
	s.Robots[0].InvulnS, s.Robots[0].MaxHpX10, s.Robots[0].MaxEnergyX10 = nil, nil, nil
	s.Projectiles[0].Color = ""
	s.Self.InputGeneration = nil
	b := encode(t, e, s)
	if len(b) != 22 || b[2] != 0 || binary.LittleEndian.Uint16(b[20:]) != 0 {
		t.Fatalf("unchanged quantized entities/self/radius must be omitted: %x", b)
	}
	decode(t, d, b)
	s.Tick, s.BaseTick = 102, 101
	s.Robots[0].Base.Pos.X = -1.23
	s.Robots[0].HpX10 = 0
	s.Robots[0].MaxHpX10 = ptr(int32(0))
	s.Self.DashReadyTick = ptr(uint32(77))
	b = encode(t, e, s)
	if mask := binary.LittleEndian.Uint16(b[28:]); mask != 1|4|128 {
		t.Fatalf("changed robot mask = %x", mask)
	}
	out := decode(t, d, b)[0].GetSnapshot()
	r := out.Robots[0]
	if r.Nick != "Bot" || r.Color != "#abc" || r.Base.Pos.X != -1.23 || r.HpX10 != 0 || r.EnergyX10 != 0 || r.MaxHpX10 == nil || *r.MaxHpX10 != 0 || r.InvulnS == nil || !r.Dead || !r.ShieldOn {
		t.Fatalf("partial record not hydrated: %v", r)
	}
	if out.Self.GetInputGeneration() != 9 || out.Self.GetDashReadyTick() != 77 {
		t.Fatalf("sparse generation lost: %v", out.Self)
	}
	// Returned messages must not alias either codec's baseline.
	r.Nick = "mutated"
	s.Tick, s.BaseTick, s.Robots[0].HpX10 = 103, 102, 1
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot().Robots[0].Nick; got != "Bot" {
		t.Fatalf("caller mutated baseline: %q", got)
	}
}

func TestFullResetTombstoneAndReentry(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	decode(t, d, encode(t, e, goldenSnapshot()))
	gone := &ombv1.SnapshotDelta{Tick: 101, BaseTick: 100, RobotGone: []uint32{1}, ProjectileGone: []uint32{2}, CoreGone: []uint32{3}, UplinkGone: []uint32{4}, HealthPackGone: []uint32{5}, PointDropGone: []uint32{6}}
	out := decode(t, d, encode(t, e, gone))[0].GetSnapshot()
	if !proto.Equal(gone, out) {
		t.Fatalf("tombstones changed: %v", out)
	}
	s := goldenSnapshot()
	s.Full, s.Tick, s.BaseTick = false, 102, 101
	s.Robots[0].Nick = ""
	s.Robots[0].Color = ""
	s.Robots[0].InvulnS, s.Robots[0].MaxHpX10, s.Robots[0].MaxEnergyX10 = nil, nil, nil
	r := decode(t, d, encode(t, e, s))[0].GetSnapshot().Robots[0]
	if r.Nick != "" || r.Color != "" || r.InvulnS != nil || r.MaxHpX10 != nil || r.MaxEnergyX10 != nil {
		t.Fatalf("reentry reused dead baseline: %v", r)
	}
	decode(t, d, encode(t, e, &ombv1.SnapshotDelta{Tick: 103, Full: true}))
	s.Tick, s.BaseTick = 104, 103
	out = decode(t, d, encode(t, e, s))[0].GetSnapshot()
	if len(out.Robots) != 1 || out.Self == nil || out.VisionRadius == nil {
		t.Fatal("full did not clear entity/self/radius baselines")
	}
	e.Reset()
	d.Reset()
	s.Full = true
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); len(got.Robots) != 1 || got.Self == nil || got.VisionRadius == nil {
		t.Fatal("explicit reset lost full state")
	}
}

func TestGapReturnsHeaderOnlyUntilFull(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	s := goldenSnapshot()
	decode(t, d, encode(t, e, s))
	s.Full, s.Tick, s.BaseTick, s.Robots[0].HpX10 = false, 101, 100, 900
	lost := encode(t, e, s)
	s.Tick, s.BaseTick, s.Robots[0].HpX10 = 102, 101, 800
	gap := encode(t, e, s)
	for _, b := range [][]byte{gap, lost} {
		got := decode(t, d, b)[0].GetSnapshot()
		if got.Full || len(got.Robots) != 0 || got.Self != nil || got.VisionRadius != nil || got.AckSeq != 7 || got.Phase != 1 || got.TimeLeftS != 300 {
			t.Fatalf("gap must only publish header: %v", got)
		}
		if got.Tick != binary.LittleEndian.Uint32(b[3:]) || got.BaseTick != binary.LittleEndian.Uint32(b[7:]) {
			t.Fatal("gap lost original tick/base tick")
		}
	}
	s.Full, s.Tick = true, 103
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); !got.Full || got.Robots[0].HpX10 != 800 {
		t.Fatal("full did not recover from gap")
	}
	if got := decode(t, wire.NewDecoder(), gap)[0].GetSnapshot(); len(got.Robots) != 0 || got.Tick != 102 {
		t.Fatal("delta without baseline must request resync through header")
	}
}

func TestEncoderWriterGapReturnsHeadersUntilFull(t *testing.T) {
	e := wire.NewEncoder()
	encode(t, e, goldenSnapshot())
	s := goldenSnapshot()
	s.Full, s.Tick, s.BaseTick = false, 103, 102
	for _, ticks := range [][2]uint32{{103, 102}, {101, 100}, {104, 103}} {
		s.Tick, s.BaseTick = ticks[0], ticks[1]
		b := encode(t, e, s)
		if len(b) != 22 || b[2] != 0 || binary.LittleEndian.Uint32(b[3:]) != s.Tick || binary.LittleEndian.Uint32(b[7:]) != s.BaseTick {
			t.Fatalf("writer gap must emit original header: %x", b)
		}
	}
	s.Full, s.Tick = true, 105
	d := wire.NewDecoder()
	decode(t, d, encode(t, e, s))
	s.Full, s.Tick, s.BaseTick, s.Robots[0].HpX10 = false, 106, 105, 0
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); len(got.Robots) != 1 || got.Robots[0].HpX10 != 0 {
		t.Fatal("writer failed to recover after full")
	}
}

func TestBatchAtomicityAndProtobufResets(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	s := goldenSnapshot()
	full := encode(t, e, s)
	decode(t, d, full)
	s.Full, s.Tick, s.BaseTick, s.Robots[0].HpX10 = false, 101, 100, 0
	delta := encode(t, e, s)
	bootstrap := protobuf(t, &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapHash: "seven"}}}}})
	for _, first := range [][]byte{delta, bootstrap} {
		if msgs, err := d.DecodeFrame(batch(first, []byte{4, 99})); err == nil || len(msgs) != 0 {
			t.Fatal("malformed batch published messages")
		}
	}
	if got := decode(t, d, delta)[0].GetSnapshot(); len(got.Robots) != 1 || got.Robots[0].HpX10 != 0 {
		t.Fatal("malformed batch committed state/reset")
	}
	msgs := decode(t, d, batch(bootstrap, full))
	if len(msgs) != 2 || msgs[0].GetEvent().GetMapBootstrap().MapHash != "seven" || !msgs[1].GetSnapshot().Full {
		t.Fatal("batch delivery order changed")
	}
	decode(t, d, bootstrap)
	if got := decode(t, d, delta)[0].GetSnapshot(); len(got.Robots) != 0 {
		t.Fatal("bootstrap failed to clear baseline")
	}
	decode(t, d, full)
	legacy := protobuf(t, &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{Tick: 100, Full: true}}})
	if !decode(t, d, legacy)[0].GetSnapshot().Full {
		t.Fatal("protobuf full not delivered")
	}
	if got := decode(t, d, delta)[0].GetSnapshot(); len(got.Robots) != 0 {
		t.Fatal("protobuf full failed to reset compact baseline")
	}
}

func TestTruncationAtEveryByteIsAtomic(t *testing.T) {
	e := wire.NewEncoder()
	full := encode(t, e, goldenSnapshot())
	s := goldenSnapshot()
	s.Tick, s.BaseTick, s.Full, s.Robots[0].HpX10 = 101, 100, false, 1
	delta := encode(t, e, s)
	for _, frame := range [][]byte{full, batch(full, delta)} {
		for end := 0; end < len(frame); end++ {
			d := wire.NewDecoder()
			if msgs, err := d.DecodeFrame(frame[:end]); err == nil || len(msgs) != 0 {
				t.Fatalf("truncation %d/%d accepted", end, len(frame))
			}
			if got := decode(t, d, delta)[0].GetSnapshot(); len(got.Robots) != 0 {
				t.Fatalf("truncation %d/%d committed a baseline", end, len(frame))
			}
		}
	}
	// A malformed delta must also leave an existing baseline intact.
	for end := 0; end < len(delta); end++ {
		d := wire.NewDecoder()
		decode(t, d, full)
		if _, err := d.DecodeFrame(delta[:end]); err == nil {
			t.Fatalf("delta truncation %d accepted", end)
		}
		if got := decode(t, d, delta)[0].GetSnapshot(); len(got.Robots) != 1 {
			t.Fatalf("delta truncation %d damaged baseline", end)
		}
	}
}

func TestHeadingWrappingAndCentimetreBounds(t *testing.T) {
	for _, heading := range []float32{0, math.Pi / 2, -math.Pi / 2, 2 * math.Pi, -2 * math.Pi, 9 * math.Pi} {
		s := &ombv1.SnapshotDelta{Full: true, Robots: []*ombv1.RobotState{{Base: base(1, -327.68, 327.67, heading)}}}
		b := encode(t, wire.NewEncoder(), s)
		r := decode(t, wire.NewDecoder(), b)[0].GetSnapshot().Robots[0]
		wrapped := math.Mod(float64(heading), 2*math.Pi)
		if wrapped < 0 {
			wrapped += 2 * math.Pi
		}
		want := float64(uint16(uint32(math.Round(wrapped*65536/(2*math.Pi))))) * 2 * math.Pi / 65536
		if math.Abs(float64(r.Base.Heading)-want) > 1e-6 || r.Base.Pos.X != -327.68 || r.Base.Pos.Y != 327.67 {
			t.Fatalf("heading/coordinate mismatch: %v", r.Base)
		}
	}
}

func BenchmarkSnapshotSize(b *testing.B) {
	full := goldenSnapshot()
	for _, count := range []int{1, 32, 256} {
		b.Run(stringCount(count), func(b *testing.B) {
			s := proto.Clone(full).(*ombv1.SnapshotDelta)
			s.Robots = nil
			for i := 0; i < count; i++ {
				r := proto.Clone(full.Robots[0]).(*ombv1.RobotState)
				r.Base.Id = uint32(i + 1)
				s.Robots = append(s.Robots, r)
			}
			e := wire.NewEncoder()
			initial := encode(b, e, s)
			legacy := protobuf(b, &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: s}})
			s.Full = false
			for _, r := range s.Robots {
				r.Nick, r.Color = "", ""
			}
			b.ReportAllocs()
			b.ResetTimer()
			var deltaBytes int
			for i := 0; i < b.N; i++ {
				s.BaseTick = s.Tick
				s.Tick++
				for _, r := range s.Robots {
					r.Base.Pos.X = float64(i%100) / 100
				}
				frame := encode(b, e, s)
				deltaBytes = len(frame)
			}
			b.ReportMetric(float64(deltaBytes), "delta-B")
			b.ReportMetric(float64(len(initial)), "full-B")
			b.ReportMetric(float64(len(legacy)), "protobuf-full-B")
		})
	}
}

func stringCount(n int) string {
	if n == 1 {
		return "1-player"
	}
	if n == 32 {
		return "32-players"
	}
	return "256-players"
}
