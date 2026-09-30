package sim

import (
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func TestWallSlideRetainsTangentialMotion(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(42, []uint32{1}, sink)
	if err := s.SetWalls([]Wall{{ID: 10, Min: Vec2{1, -10}, Max: Vec2{2, 10}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{.38, 0}, 0); err != nil {
		t.Fatal(err)
	}
	s.robots[0].Velocity = Vec2{3, 4}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 375, MoveY: 500})
	s.Tick()
	r := mustRobot(t, s, 1)
	closeFloat(t, r.Position.X, 1-RobotRadius)
	closeFloat(t, r.Position.Y, 4*DT)
	closeFloat(t, r.Velocity.X, 0)
	closeFloat(t, r.Velocity.Y, 4)
	if len(sink.events) != 2 || sink.events[1].GetWallHit() == nil {
		t.Fatal("missing wall contact event")
	}
	closeFloat(t, float64(sink.events[1].GetWallHit().Impact), 3)
	closeFloat(t, sink.events[1].GetWallHit().At.Y, 4*.02/3)
}

func TestWallHitThrottlePerRobot(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(42, []uint32{2, 1}, sink)
	if err := s.SetWalls([]Wall{{ID: 10, Min: Vec2{RobotRadius, -10}, Max: Vec2{1, 10}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{0, -2}, 0); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(2, Vec2{0, 2}, 1); err != nil {
		t.Fatal(err)
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000})
	advance(s, 16)
	s.ApplyInput(2, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000})
	advance(s, 91)
	hits := map[uint32][]uint32{}
	for _, ev := range sink.events {
		if wall := ev.GetWallHit(); wall != nil {
			hits[wall.Robot] = append(hits[wall.Robot], ev.Tick)
			closeFloat(t, wall.At.X, 0)
			closeFloat(t, wall.At.Y, float64(wall.Robot)*4-6)
			if math.Abs(float64(wall.Impact)-Acceleration*DT) > 1e-7 {
				t.Fatalf("wrong impact %g", wall.Impact)
			}
		}
	}
	if !reflect.DeepEqual(hits[1], []uint32{1, 31, 61, 91}) || !reflect.DeepEqual(hits[2], []uint32{17, 47, 77}) {
		t.Fatalf("wrong independent throttle: %v", hits)
	}
	for _, id := range []uint32{1, 2} {
		r := mustRobot(t, s, id)
		if r.Position != (Vec2{0, float64(id)*4 - 6}) || r.Velocity != (Vec2{}) {
			t.Fatalf("robot %d penetrated wall", id)
		}
	}
	// Throttling applies only to telemetry, never to collision response.
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove), MoveX: -1000})
	s.Tick()
	if r := mustRobot(t, s, 1); r.Position.X >= 0 || r.Velocity.X >= 0 {
		t.Fatal("robot stuck moving away from wall")
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 3, AxisMask: uint32(AxisMove), MoveX: 1000})
	advance(s, 100)
	if r := mustRobot(t, s, 1); r.Position.X > 1e-10 || r.Velocity.X != 0 {
		t.Fatal("suppressed hit allowed penetration")
	}
}

func TestSweepWallGeometry(t *testing.T) {
	w := Wall{ID: 1, Min: Vec2{0, 0}, Max: Vec2{1, 1}}
	cornerTime := (2 - RobotRadius/math.Sqrt2) / 2
	tests := []struct {
		name string
		p, d Vec2
		want float64
		hit  bool
	}{
		{"left", Vec2{-2, .5}, Vec2{2, 0}, .7, true},
		{"right", Vec2{3, .5}, Vec2{-2, 0}, .7, true},
		{"bottom", Vec2{.5, -2}, Vec2{0, 2}, .7, true},
		{"top", Vec2{.5, 3}, Vec2{0, -2}, .7, true},
		{"bottom_left", Vec2{-2, -2}, Vec2{2, 2}, cornerTime, true},
		{"bottom_right", Vec2{3, -2}, Vec2{-2, 2}, cornerTime, true},
		{"top_left", Vec2{-2, 3}, Vec2{2, -2}, cornerTime, true},
		{"top_right", Vec2{3, 3}, Vec2{-2, -2}, cornerTime, true},
		{"touch_into", Vec2{-.6, .5}, Vec2{.1, 0}, 0, true},
		{"touch_away", Vec2{-.6, .5}, Vec2{-.1, 0}, 0, false},
		{"touch_parallel", Vec2{-.6, .5}, Vec2{0, .1}, 0, false},
		{"stationary", Vec2{-.6, .5}, Vec2{}, 0, false},
		{"exact_end", Vec2{-.7, .5}, Vec2{.1, 0}, 1, true},
		{"too_short", Vec2{-2, .5}, Vec2{1, 0}, 0, false},
		{"outside_face", Vec2{-2, 2}, Vec2{2, 0}, 0, false},
		{"rounded_corner_not_square", Vec2{-.5, -.5}, Vec2{.01, .01}, 0, false},
		{"corner_tangent", Vec2{-2, -.6}, Vec2{4, 0}, 0, false},
		{"inside_rejected", Vec2{.5, .5}, Vec2{1, 0}, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, hit := sweepWall(tt.p, tt.d, w)
			if hit != tt.hit {
				t.Fatalf("hit=%v, want %v (fraction %g)", hit, tt.hit, got)
			}
			if hit {
				closeFloat(t, got, tt.want)
			}
		})
	}
}

func TestSweepWallDoesNotTunnel(t *testing.T) {
	w := Wall{ID: 1, Min: Vec2{0, -1}, Max: Vec2{.001, 1}}
	fraction, hit := sweepWall(Vec2{-10, 0}, Vec2{20, 0}, w)
	if !hit {
		t.Fatal("sweep passed through thin wall")
	}
	closeFloat(t, fraction, (10-RobotRadius)/20)
	// The simulated step also chooses the nearest obstacle, not slice/ID order.
	s := NewSim(0, []uint32{1}, nil)
	if err := s.SetWalls([]Wall{
		{ID: 1, Min: Vec2{2, -1}, Max: Vec2{2.001, 1}},
		{ID: 2, Min: Vec2{1, -1}, Max: Vec2{1.001, 1}},
	}); err != nil {
		t.Fatal(err)
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000})
	advance(s, 100)
	r := mustRobot(t, s, 1)
	closeFloat(t, r.Position.X, 1-RobotRadius)
	if r.Velocity != (Vec2{}) {
		t.Fatal("wall hit did not zero velocity")
	}
}

func TestWallAndSpawnConfiguration(t *testing.T) {
	s := NewSim(0, []uint32{1}, nil)
	walls := []Wall{{ID: 7, Min: Vec2{1, -1}, Max: Vec2{2, 1}}}
	if err := s.SetWalls(walls); err != nil {
		t.Fatal(err)
	}
	walls[0].Min.X = -10
	before := s.Snapshot()
	invalid := [][]Wall{
		{{ID: 0, Min: Vec2{1, 1}, Max: Vec2{2, 2}}},
		{{ID: 2, Min: Vec2{2, 2}, Max: Vec2{1, 1}}},
		{{ID: 2, Min: Vec2{1, 1}, Max: Vec2{1, 2}}},
		{{ID: 2, Min: Vec2{math.NaN(), 1}, Max: Vec2{2, 2}}},
		{{ID: 2, Min: Vec2{1, 1}, Max: Vec2{math.Inf(1), 2}}},
		{{ID: 2, Min: Vec2{-.1, -.1}, Max: Vec2{.1, .1}}},
		{{ID: 2, Min: Vec2{1, 1}, Max: Vec2{2, 2}}, {ID: 2, Min: Vec2{3, 3}, Max: Vec2{4, 4}}},
	}
	for _, walls := range invalid {
		if err := s.SetWalls(walls); err == nil {
			t.Fatalf("invalid wall accepted: %+v", walls)
		}
		if !reflect.DeepEqual(before, s.Snapshot()) {
			t.Fatal("failed SetWalls partially mutated map")
		}
	}
	if err := s.SetSpawn(1, Vec2{1, 0}, 0); err == nil {
		t.Fatal("spawn inside wall accepted")
	}
	if err := s.SetSpawn(9, Vec2{}, 0); err == nil {
		t.Fatal("unknown robot spawn accepted")
	}
	if err := s.SetSpawn(1, Vec2{}, 8); err == nil {
		t.Fatal("invalid sector accepted")
	}
	if err := s.SetSpawn(1, Vec2{math.Inf(-1), 0}, 0); err == nil {
		t.Fatal("nonfinite spawn accepted")
	}
	if err := s.SetSpawn(1, Vec2{0, 2}, 7); err != nil {
		t.Fatal(err)
	}
	cp := s.Snapshot()
	cp.Walls[0].Min.X = -100
	if s.Snapshot().Walls[0].Min.X != 1 {
		t.Fatal("snapshot aliases wall geometry")
	}
	s.Tick()
	if err := s.SetWalls(nil); err == nil {
		t.Fatal("running map mutated")
	}
	if err := s.SetSpawn(1, Vec2{}, 0); err == nil {
		t.Fatal("running spawn mutated")
	}
}

func TestSweepToleranceDoesNotPermitInwardPenetration(t *testing.T) {
	w := Wall{ID: 1, Min: Vec2{}, Max: Vec2{1, 1}}
	for _, tc := range []struct {
		name string
		p, d Vec2
	}{
		{"face", Vec2{-.6 + 5e-11, .5}, Vec2{.1, 0}},
		{"corner", Vec2{-1, -1}.Scale((.6 - 5e-11) / math.Sqrt2), Vec2{1, 1}.Scale(.1 / math.Sqrt2)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if overlapsWall(tc.p, w) {
				t.Fatal("fixture must be accepted by overlap tolerance")
			}
			fraction, normal, hit := sweepWallNormal(tc.p, tc.d, w)
			if !hit || fraction != 0 || math.Abs(normal.Len()-1) > 1e-12 {
				t.Fatalf("inward tolerance contact missed: t=%g n=%v hit=%v", fraction, normal, hit)
			}
			if _, _, hit := sweepWallNormal(tc.p, tc.d.Scale(-1), w); hit {
				t.Fatal("outward escape blocked")
			}
		})
	}
	if fraction, hit := sweepCircle(Vec2{10.6 - 4e-12, 0}, Vec2{-.001, 0}, Vec2{}, 10.6); !hit || fraction != 0 {
		t.Fatalf("circle tolerance contact missed: t=%g hit=%v", fraction, hit)
	}
}

func TestSweepEpsilonTieKeepsEarliestFraction(t *testing.T) {
	w := Wall{ID: 1, Min: Vec2{}, Max: Vec2{1, 1}}
	p := Vec2{-1.6 + 5e-11, .5}
	want := -RobotRadius - p.X
	if got, _, hit := sweepWallNormal(p, Vec2{1, 0}, w); !hit || math.Abs(got-want) > 1e-14 {
		t.Fatalf("late single contact: got %.15f want %.15f", got, want)
	}
	s := NewSim(0, []uint32{1}, nil)
	s.walls = []Wall{{ID: 1, Min: Vec2{1.1, -1}, Max: Vec2{2, 1}}, {ID: 2, Min: Vec2{1.1 - 5e-11, -1}, Max: Vec2{2, 1}}}
	want = s.walls[1].Min.X - RobotRadius
	if got := s.sweepContact(Vec2{}, Vec2{1, 0}); !got.hit || math.Abs(got.t-want) > 1e-14 {
		t.Fatalf("late multi-wall contact: got %.15f want %.15f", got.t, want)
	}
}
