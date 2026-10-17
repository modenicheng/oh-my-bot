package wire_test

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"strings"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/wire"

	"google.golang.org/protobuf/proto"
)

func TestTimeLeftUsesUint32IncludingWarmup(t *testing.T) {
	for _, seconds := range []uint32{0, 65535, 65536, 86400, math.MaxUint32} {
		t.Run(fmt.Sprint(seconds), func(t *testing.T) {
			e, d := wire.NewEncoder(), wire.NewDecoder()
			s := &ombv1.SnapshotDelta{Tick: 1, Full: true, TimeLeftS: seconds}
			full := encode(t, e, s)
			if len(full) != 22 || binary.LittleEndian.Uint32(full[16:20]) != seconds || binary.LittleEndian.Uint16(full[20:]) != 0 {
				t.Fatalf("incorrect u32 time/header: %x", full)
			}
			if got := decode(t, d, full)[0].GetSnapshot(); !proto.Equal(got, s) {
				t.Fatalf("time left did not round-trip: %v", got)
			}
			s.Full, s.Tick, s.BaseTick = false, 2, 1
			delta := encode(t, e, s)
			if got := decode(t, d, delta)[0].GetSnapshot(); !proto.Equal(got, s) {
				t.Fatalf("delta time left did not round-trip: %v", got)
			}
			if got := decode(t, wire.NewDecoder(), batch(full, delta)); len(got) != 2 || got[1].GetSnapshot().TimeLeftS != seconds {
				t.Fatal("batch lost u32 time left")
			}
			s.Tick, s.BaseTick = 4, 3
			gap := encode(t, e, s)
			if len(gap) != 22 || binary.LittleEndian.Uint32(gap[16:20]) != seconds {
				t.Fatalf("writer gap lost u32 time left: %x", gap)
			}
			if got := decode(t, d, gap)[0].GetSnapshot(); !proto.Equal(got, s) {
				t.Fatalf("reader gap lost u32 time left: %v", got)
			}
		})
	}
}

func TestAiRoundsUsesUint32IncludingConfigured65536(t *testing.T) {
	for _, rounds := range []uint32{0, 65535, 65536, math.MaxUint32} {
		t.Run(fmt.Sprint(rounds), func(t *testing.T) {
			e, d := wire.NewEncoder(), wire.NewDecoder()
			s := &ombv1.SnapshotDelta{Tick: 1, Full: true, Self: &ombv1.SelfState{
				RobotId: 7, MoveSrc: 1, TurretSrc: 2, AiRoundsLeft: rounds, AiTokensLeftK: 0xaabbccdd,
				AssistOn: ptr(false), InputGeneration: ptr(uint32(9)),
			}}
			full := encode(t, e, s)
			if binary.LittleEndian.Uint32(full[30:34]) != rounds || binary.LittleEndian.Uint32(full[34:38]) != s.Self.AiTokensLeftK {
				t.Fatalf("incorrect u32 rounds/token layout: %x", full)
			}
			if got := decode(t, d, full)[0].GetSnapshot(); !proto.Equal(got, s) {
				t.Fatalf("rounds did not round-trip: %v", got)
			}
			s.Full, s.Tick, s.BaseTick = false, 2, 1
			s.Self.AiRoundsLeft ^= 1
			delta := encode(t, e, s)
			if got := decode(t, d, delta)[0].GetSnapshot(); !proto.Equal(got, s) {
				t.Fatalf("delta rounds did not round-trip: %v", got)
			}
			if got := decode(t, wire.NewDecoder(), batch(full, delta)); len(got) != 2 || !proto.Equal(got[1].GetSnapshot(), s) {
				t.Fatal("batch lost u32 rounds or following self fields")
			}
		})
	}
}

func TestEmptySnapshotAndInitiallyAbsentOptionals(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	s := &ombv1.SnapshotDelta{Full: true, Tick: 1, Self: &ombv1.SelfState{},
		Robots: []*ombv1.RobotState{{Base: base(1, 0, 0, 0)}}}
	out := decode(t, d, encode(t, e, s))[0].GetSnapshot()
	if !proto.Equal(out, s) || out.Self.InputGeneration != nil || out.Robots[0].InvulnS != nil {
		t.Fatalf("initially absent optionals changed: %v", out)
	}
	s.Tick, s.BaseTick, s.Full = 2, 1, false
	s.Self.InputGeneration = ptr(uint32(0))
	s.Robots[0].InvulnS = ptr(uint32(0))
	s.Robots[0].MaxHpX10 = ptr(int32(0))
	s.Robots[0].MaxEnergyX10 = ptr(int32(0))
	out = decode(t, d, encode(t, e, s))[0].GetSnapshot()
	if !proto.Equal(out, s) || out.Self.InputGeneration == nil || out.Robots[0].InvulnS == nil {
		t.Fatalf("explicit first zero was omitted: %v", out)
	}
	s = &ombv1.SnapshotDelta{Full: true, Tick: 3}
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); !proto.Equal(got, s) {
		t.Fatalf("empty phase 0 full rejected: %v", got)
	}
	s = &ombv1.SnapshotDelta{Tick: 4, BaseTick: 3}
	if got := decode(t, d, encode(t, e, s))[0].GetSnapshot(); !proto.Equal(got, s) {
		t.Fatalf("empty phase 0 delta rejected: %v", got)
	}
}

func TestAllEntityPartialFieldsHydrate(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	s := goldenSnapshot()
	decode(t, d, encode(t, e, s))
	s.Tick, s.BaseTick, s.Full = 101, 100, false
	s.Robots[0].Dashing = true
	s.Robots[0].EnergyX10 = -10
	s.Robots[0].RespawnInS = 3
	s.Robots[0].InvulnS = ptr(uint32(2))
	s.Projectiles[0].Base.Pos.X = 3
	s.Cores[0].Value = math.MinInt32
	s.Uplinks[0].MyCooldownS = 65535
	s.HealthPacks[0].RespawnInS = 65535
	s.PointDrops[0].Points = math.MaxInt32
	out := decode(t, d, encode(t, e, s))[0].GetSnapshot()
	if !out.Robots[0].Dashing || out.Robots[0].EnergyX10 != -10 || out.Robots[0].RespawnInS != 3 || *out.Robots[0].InvulnS != 2 || out.Robots[0].Nick != "Bot" {
		t.Fatalf("robot fields lost: %v", out.Robots)
	}
	if out.Projectiles[0].OwnerId != 1 || out.Projectiles[0].Color != "#abc" || out.Projectiles[0].Base.Pos.X != 3 || out.Projectiles[0].Base.Pos.Y != -2 {
		t.Fatalf("projectile fields lost: %v", out.Projectiles)
	}
	if out.Cores[0].Value != math.MinInt32 || out.Cores[0].Base.Pos.X != 0 || out.Uplinks[0].Base.Pos.Y != -1 || out.Uplinks[0].MyCooldownS != 65535 || !out.HealthPacks[0].Available || out.HealthPacks[0].RespawnInS != 65535 || out.PointDrops[0].Points != math.MaxInt32 {
		t.Fatalf("public object fields lost: %v", out)
	}
	s.Tick, s.BaseTick = 102, 101
	s.Projectiles[0].OwnerId, s.Projectiles[0].Color = 0, "new"
	s.Uplinks[0].Ready, s.Uplinks[0].HackingId, s.Uplinks[0].ProgressX10 = true, 17, -2
	s.HealthPacks[0].Available = false
	out = decode(t, d, encode(t, e, s))[0].GetSnapshot()
	if out.Projectiles[0].OwnerId != 0 || out.Projectiles[0].Color != "new" || !out.Uplinks[0].Ready || out.Uplinks[0].HackingId != 17 || out.Uplinks[0].ProgressX10 != -2 || out.HealthPacks[0].Available || out.HealthPacks[0].RespawnInS != 65535 {
		t.Fatalf("zero/state transitions lost: %v", out)
	}
}

func TestExactFrameAndBatchLimits(t *testing.T) {
	// 22 header + 2 count + 6 record + 4 pos + 2 heading + 4 owner
	// + 2 UTF-8 byte length + 65494 bytes = exactly 65536 bytes.
	s := &ombv1.SnapshotDelta{Full: true, Projectiles: []*ombv1.ProjectileState{
		{Base: base(1, 0, 0, 0), Color: strings.Repeat("a", 65494)},
	}}
	b := encode(t, wire.NewEncoder(), s)
	if len(b) != wire.MaxFrameBytes || len(decode(t, wire.NewDecoder(), b)[0].GetSnapshot().Projectiles[0].Color) != 65494 {
		t.Fatal("exact maximum valid frame rejected")
	}
	s.Projectiles[0].Color += "a"
	if _, err := wire.NewEncoder().EncodeSnapshot(s); err == nil {
		t.Fatal("frame one byte too large accepted")
	}
	children := make([][]byte, wire.MaxBatchChildren)
	for i := range children {
		children[i] = []byte{3}
	}
	if msgs := decode(t, wire.NewDecoder(), batch(children...)); len(msgs) != wire.MaxBatchChildren {
		t.Fatal("maximum batch count rejected")
	}
	if _, err := wire.NewDecoder().DecodeFrame(batch(append(children, []byte{3})...)); err == nil {
		t.Fatal("batch one child too large accepted")
	}
	if msgs := decode(t, wire.NewDecoder(), batch()); len(msgs) != 0 {
		t.Fatal("empty batch changed delivery")
	}
}

func TestMalformedGapDoesNotPoisonBaseline(t *testing.T) {
	e, d := wire.NewEncoder(), wire.NewDecoder()
	full := encode(t, e, goldenSnapshot())
	decode(t, d, full)
	s := goldenSnapshot()
	s.Tick, s.BaseTick, s.Full, s.Robots[0].HpX10 = 101, 100, false, 1
	delta := encode(t, e, s)
	gap := bytes.Clone(delta)
	binary.LittleEndian.PutUint32(gap[7:], 99)
	for _, malformed := range [][]byte{append(bytes.Clone(gap), 0), batch(gap, []byte{4, 99}), append(bytes.Clone(full), 0)} {
		if _, err := d.DecodeFrame(malformed); err == nil {
			t.Fatal("malformed stream accepted")
		}
	}
	if got := decode(t, d, delta)[0].GetSnapshot(); len(got.Robots) != 1 || got.Robots[0].HpX10 != 1 {
		t.Fatal("malformed gap/full/batch poisoned live baseline")
	}
}

func TestEncodeErrorOnFullDoesNotReset(t *testing.T) {
	e, reference := wire.NewEncoder(), wire.NewEncoder()
	s := goldenSnapshot()
	encode(t, e, s)
	encode(t, reference, s)
	bad := goldenSnapshot()
	bad.Self.Upgrade.Levels = []uint32{11}
	if _, err := e.EncodeSnapshot(bad); err == nil {
		t.Fatal("invalid full accepted")
	}
	s.Tick, s.BaseTick, s.Full, s.Robots[0].HpX10 = 101, 100, false, 7
	if !bytes.Equal(encode(t, e, s), encode(t, reference, s)) {
		t.Fatal("invalid full reset the live encoder baseline")
	}
}

func TestValidUnicodeStrings(t *testing.T) {
	s := goldenSnapshot()
	s.Robots[0].Nick = "\u673a\u5668\u4eba\U0001f916"
	out := decode(t, wire.NewDecoder(), encode(t, wire.NewEncoder(), s))[0].GetSnapshot()
	if out.Robots[0].Nick != s.Robots[0].Nick {
		t.Fatal("UTF-8 byte lengths changed text")
	}
}

func FuzzDecodeFrame(f *testing.F) {
	full := encode(f, wire.NewEncoder(), goldenSnapshot())
	for _, seed := range [][]byte{nil, {3}, {4, 1}, {5, 1, 0, 0}, full, batch(full, []byte{3})} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		d := wire.NewDecoder()
		decode(t, d, full)
		msgs, err := d.DecodeFrame(b)
		if err != nil && len(msgs) != 0 {
			t.Fatal("error leaked messages")
		}
	})
}
