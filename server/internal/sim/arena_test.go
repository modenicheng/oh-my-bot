package sim

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func arenaSim(t *testing.T, version int, ids ...uint32) *Sim {
	t.Helper()
	s := NewSim(42, ids, nil)
	m := gameMap()
	m.GeneratorVer = version
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestArenaMovementAndDash(t *testing.T) {
	for _, dash := range []bool{false, true} {
		for _, angle := range []float64{0, math.Pi / 4, math.Pi / 2, math.Pi, 7 * math.Pi / 4} {
			t.Run(fmt.Sprintf("dash=%v/angle=%g", dash, angle), func(t *testing.T) {
				s := arenaSim(t, 2, 1)
				d := Vec2{math.Cos(angle), math.Sin(angle)}
				if err := s.SetSpawn(1, d.Scale(79.35), 0); err != nil {
					t.Fatal(err)
				}
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove | AxisAbility), MoveX: int32(d.X * 1000), MoveY: int32(d.Y * 1000), Dash: dash})
				for i := 0; i < 90; i++ {
					s.Tick()
					if r := s.robots[0].Position.Len(); r > 79.4+1e-9 {
						t.Fatalf("tick %d radius %.12f", s.tick, r)
					}
				}
				if !s.robots[0].HasWallHit {
					t.Fatal("missing boundary wall hit")
				}
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove | AxisAbility), MoveX: int32(-d.X * 1000), MoveY: int32(-d.Y * 1000)})
				stepTicks(s, 30)
				if s.robots[0].Position.Len() > 78 {
					t.Fatal("cannot move inward from boundary")
				}
			})
		}
	}
}

func TestArenaSoftCollisionAndSpawn(t *testing.T) {
	s := arenaSim(t, 2, 1, 2)
	if err := s.SetSpawn(1, Vec2{79.41, 0}, 0); err == nil {
		t.Error("accepted outside spawn")
	}
	if s.freePosition(Vec2{79.41, 0}) {
		t.Error("outside position marked free")
	}
	s.robots[0].Position = Vec2{79.4, 0}
	s.robots[1].Position = Vec2{78.5, 0}
	for i := 0; i < 30; i++ {
		s.softCollide()
	}
	if r := s.robots[0].Position.Len(); r > 79.4+1e-9 {
		t.Errorf("soft collision escaped: %g", r)
	}
	before := s.Snapshot()
	bad := cloneMap(before.Map)
	bad.Sectors[0].SpawnArea = Rect{Min: Vec2{80, 0}, Max: Vec2{81, 1}}
	if err := s.SetMap(bad); err == nil {
		t.Error("accepted outside spawn area")
	}
	if !reflect.DeepEqual(before, s.Snapshot()) {
		t.Error("rejected map changed state")
	}
}

func TestArenaCheckpointReplayVersions(t *testing.T) {
	for _, version := range []int{1, 2} {
		t.Run(fmt.Sprintf("gen%d", version), func(t *testing.T) {
			var buf bytes.Buffer
			log, err := NewMatchEventLogWriter(&buf)
			if err != nil {
				t.Fatal(err)
			}
			s := NewSim(42, []uint32{1, 2}, log)
			m := gameMap()
			m.GeneratorVer = version
			if err := s.SetMap(m); err != nil {
				t.Fatal(err)
			}
			if err := s.SetSpawn(1, Vec2{79.3, 0}, 0); err != nil {
				t.Fatal(err)
			}
			if err := s.SetSpawn(2, Vec2{78.3, 0}, 0); err != nil {
				t.Fatal(err)
			}
			var middle Checkpoint
			for tick := uint32(1); tick <= 180; tick++ {
				if tick == 1 || tick == 65 {
					for _, id := range []uint32{1, 2} {
						s.ApplyInput(id, &ombv1.ClientInput{Seq: tick, AxisMask: uint32(AxisMove | AxisAbility), MoveX: 1000, Dash: tick == 1})
					}
				}
				if tick == 60 {
					s.ApplyInput(1, &ombv1.ClientInput{Seq: tick, AxisMask: uint32(AxisMove), MoveX: -1000})
				}
				if tick == 150 {
					s.Respawn(1)
				}
				s.Tick()
				if tick == 90 {
					middle = s.Snapshot()
					if version == 1 && s.robots[0].Position.Len() <= 80 {
						t.Fatal("legacy replay fixture did not leave arena")
					}
					if version == 2 && s.robots[0].Position.Len() > 79.4 {
						t.Fatal("gen2 escaped")
					}
				}
			}
			if err := log.Flush(); err != nil {
				t.Fatal(err)
			}
			records, err := ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			for _, cp := range []Checkpoint{*records[0].State, middle} {
				sink := &recordingSink{}
				replay := restoreGameplay(t, cp, sink)
				replayGameplay(t, replay, records, 180)
				want, _ := json.Marshal(s.Snapshot())
				got, _ := json.Marshal(replay.Snapshot())
				if !bytes.Equal(want, got) {
					t.Fatalf("gen%d replay state diverged from tick %d", version, cp.Tick)
				}
				expected := []*ombv1.ServerEvent{}
				for _, rec := range records {
					if rec.Event != nil && rec.Event.Tick > cp.Tick {
						expected = append(expected, rec.Event)
					}
				}
				want, _ = json.Marshal(expected)
				got, _ = json.Marshal(sink.events)
				if !bytes.Equal(want, got) {
					t.Fatalf("gen%d replay events diverged from tick %d", version, cp.Tick)
				}
			}
		})
	}
}

func TestArenaLegacyAndNoMapRemainUnbounded(t *testing.T) {
	for _, version := range []int{-1, 0, 1} {
		s := NewSim(42, []uint32{1}, nil)
		if version >= 0 {
			s = arenaSim(t, version, 1)
		}
		if err := s.SetSpawn(1, Vec2{81, 0}, 0); err != nil {
			t.Fatal(err)
		}
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000})
		stepTicks(s, 30)
		if s.robots[0].Position.X <= 82 {
			t.Fatalf("legacy version %d clamped", version)
		}
	}
}
