package sim

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func TestArenaTangentRetainsTickDisplacement(t *testing.T) {
	for _, speed := range []float64{MaxSpeed, DashSpeed} {
		s := arenaSim(t, 2, 1)
		r := &s.robots[0]
		r.Position = Vec2{0, arenaCenterRadius}
		travel := 0.0
		for i := 0; i < 120; i++ {
			before := r.Position
			r.Velocity = Vec2{-before.Y, before.X}.Scale(speed / before.Len())
			s.slideRobot(r)
			distance := r.Position.Sub(before).Len()
			if distance < speed*DT*.999 || distance > speed*DT+1e-9 {
				t.Fatalf("speed %g tick %d lost tangent displacement: %.12f", speed, i, distance)
			}
			if radius := r.Position.Len(); radius > arenaCenterRadius+1e-9 || radius < arenaCenterRadius-1e-8 {
				t.Fatalf("speed %g tick %d drifted from boundary: %.12f", speed, i, radius)
			}
			travel += distance
		}
		if travel < speed*2*.999 {
			t.Fatalf("speed %g sustained slide travelled only %g", speed, travel)
		}
	}
}

func TestSlideRoundedCornerAndMultipleWalls(t *testing.T) {
	t.Run("rounded corner", func(t *testing.T) {
		s := NewSim(42, []uint32{1}, nil)
		wall := Wall{ID: 1, Min: Vec2{1, 1}, Max: Vec2{2, 2}}
		if err := s.SetWalls([]Wall{wall}); err != nil {
			t.Fatal(err)
		}
		r := &s.robots[0]
		r.Position, r.Velocity = Vec2{.4, .8}, Vec2{8, 4}
		s.slideRobot(r)
		if overlapsWall(r.Position, wall) || r.Position.Y <= .8 || r.Velocity.Len() == 0 {
			t.Fatalf("rounded corner did not slide safely: pos=%v vel=%v", r.Position, r.Velocity)
		}
	})
	t.Run("second wall stops remainder", func(t *testing.T) {
		s := NewSim(42, []uint32{1}, nil)
		walls := []Wall{{ID: 1, Min: Vec2{1, -5}, Max: Vec2{2, 5}}, {ID: 2, Min: Vec2{-5, 1}, Max: Vec2{1, 2}}}
		if err := s.SetWalls(walls); err != nil {
			t.Fatal(err)
		}
		r := &s.robots[0]
		r.Position, r.Velocity = Vec2{.35, .30}, Vec2{8, 8}
		s.slideRobot(r)
		closeFloat(t, r.Position.X, .4)
		closeFloat(t, r.Position.Y, .4)
		closeFloat(t, r.Velocity.Len(), 0)
		for _, w := range walls {
			if overlapsWall(r.Position, w) {
				t.Fatal("penetrated second wall")
			}
		}
	})
	t.Run("locked circle tangent", func(t *testing.T) {
		s := arenaSim(t, 2, 1)
		r := &s.robots[0]
		radius := s.mapDef.CoreZone.Radius + RobotRadius
		r.Position, r.Velocity = Vec2{radius, 0}, Vec2{-3, 4}
		s.slideRobot(r)
		closeFloat(t, r.Position.X, radius)
		closeFloat(t, r.Position.Y, 4*DT)
		closeFloat(t, r.Velocity.X, 0)
		closeFloat(t, r.Velocity.Y, 4)
	})
	t.Run("dash keeps wall tangent", func(t *testing.T) {
		s := NewSim(42, []uint32{1}, nil)
		if err := s.SetWalls([]Wall{{ID: 1, Min: Vec2{1, -5}, Max: Vec2{2, 5}}}); err != nil {
			t.Fatal(err)
		}
		if err := s.SetSpawn(1, Vec2{.38, 0}, 0); err != nil {
			t.Fatal(err)
		}
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove | AxisAbility), MoveX: 600, MoveY: 800, Dash: true})
		s.Tick()
		r := s.robots[0]
		closeFloat(t, r.Position.X, .4)
		closeFloat(t, r.Position.Y, DashSpeed*.8*DT)
		closeFloat(t, r.Velocity.X, 0)
		closeFloat(t, r.Velocity.Y, DashSpeed*.8)
	})
}

func TestSlideStartAndCheckpointReplay(t *testing.T) {
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(42, []uint32{1}, log)
	if err := s.SetWalls([]Wall{{ID: 1, Min: Vec2{1, -10}, Max: Vec2{2, 10}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{.38, 0}, 0); err != nil {
		t.Fatal(err)
	}
	s.robots[0].Velocity = Vec2{3, 4}
	var middle Checkpoint
	for tick := uint32(1); tick <= 180; tick++ {
		if tick == 1 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: tick, AxisMask: uint32(AxisMove | AxisFire), MoveX: 375, MoveY: 500, Fire: true})
		}
		if tick == 100 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: tick, AxisMask: uint32(AxisMove | AxisAbility), MoveY: 1000, Dash: true})
		}
		s.Tick()
		if tick == 90 {
			middle = s.Snapshot()
		}
	}
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	records, err := ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(s.Snapshot())
	for _, cp := range []Checkpoint{*records[0].State, middle} {
		sink := &recordingSink{}
		replay := restoreGameplay(t, cp, sink)
		replayGameplay(t, replay, records, 180)
		got, _ := json.Marshal(replay.Snapshot())
		if !bytes.Equal(want, got) {
			t.Fatalf("state diverged from checkpoint tick %d", cp.Tick)
		}
		expected := []*ombv1.ServerEvent{}
		for _, rec := range records {
			if rec.Event != nil && rec.Event.Tick > cp.Tick {
				expected = append(expected, rec.Event)
			}
		}
		wantEvents, _ := json.Marshal(expected)
		gotEvents, _ := json.Marshal(sink.events)
		if !bytes.Equal(wantEvents, gotEvents) {
			t.Fatalf("events diverged from checkpoint tick %d", cp.Tick)
		}
	}
	if math.Abs(middle.Robots[0].Position.X-.4) > 1e-9 || reflect.DeepEqual(middle, s.Snapshot()) {
		t.Fatal("checkpoint must capture a moving robot sliding along the wall")
	}
}
