package sim

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// knockFixture builds an unbounded two-robot world with directly owned state so
// impulse numerics are measured without arbitration or acceleration smoothing.
func knockFixture(velA, velB Vec2) (*Sim, *Robot, *Robot) {
	s := NewSim(42, []uint32{1, 2}, nil)
	s.robots[0].Position, s.robots[0].Velocity = Vec2{-0.5, 0}, velA
	s.robots[1].Position, s.robots[1].Velocity = Vec2{0.5, 0}, velB
	return s, &s.robots[0], &s.robots[1]
}

func speed2(v Vec2) float64 { return v.X*v.X + v.Y*v.Y }

func TestKnockbackHeadOnBounded(t *testing.T) {
	s, a, b := knockFixture(Vec2{3, 0}, Vec2{-3, 0})
	beforeA, beforeB := a.Velocity, b.Velocity
	s.softCollide()
	// Symmetric separation to exactly the touching distance.
	closeFloat(t, b.Position.Sub(a.Position).Len(), 2*RobotRadius)
	closeFloat(t, a.Position.X, -RobotRadius)
	closeFloat(t, b.Position.X, RobotRadius)
	// Equal-mass damped impulse: closing 6 changes each normal velocity by
	// (1+0.15)*6/2 = 3.45, bounded by the 4 m/s knock cap.
	closeFloat(t, a.Velocity.X, -0.45)
	closeFloat(t, b.Velocity.X, 0.45)
	for _, dv := range []float64{math.Abs(a.Velocity.X - beforeA.X), math.Abs(b.Velocity.X - beforeB.X)} {
		if dv <= 0 || dv > maxKnockSpeed {
			t.Fatalf("knock %.14g outside (0, %.14g]", dv, maxKnockSpeed)
		}
	}
	if math.Abs(a.Velocity.Y) > 1e-12 || math.Abs(b.Velocity.Y) > 1e-12 {
		t.Fatal("normal impulse changed tangential velocity")
	}
}

func TestKnockbackImpulseCap(t *testing.T) {
	t.Run("dash_into_stationary", func(t *testing.T) {
		s, a, b := knockFixture(Vec2{DashSpeed, 0}, Vec2{})
		s.softCollide()
		// Uncapped would be 9.2 m/s each; the cap holds the change to 4.
		closeFloat(t, a.Velocity.X, DashSpeed-maxKnockSpeed)
		closeFloat(t, b.Velocity.X, maxKnockSpeed)
	})
	t.Run("opposed_dashes", func(t *testing.T) {
		// Uncapped would change each velocity by 18.4 m/s; capped to 4 so no
		// knock exceeds dash policy.
		s, a, b := knockFixture(Vec2{DashSpeed, 0}, Vec2{-DashSpeed, 0})
		s.softCollide()
		closeFloat(t, a.Velocity.X, DashSpeed-maxKnockSpeed)
		closeFloat(t, b.Velocity.X, -(DashSpeed - maxKnockSpeed))
		closeFloat(t, a.Velocity.Len(), 12)
		closeFloat(t, b.Velocity.Len(), 12)
	})
}

func TestKnockbackSkipsNonApproachingDeadAndCoincident(t *testing.T) {
	for _, tc := range []struct {
		name   string
		va, vb Vec2
	}{
		{"separating", Vec2{-1, 0}, Vec2{1, 0}},
		{"stationary", Vec2{}, Vec2{}},
		{"tangential_graze", Vec2{0, 3}, Vec2{0, -3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, a, b := knockFixture(tc.va, tc.vb)
			s.softCollide()
			if a.Velocity != tc.va || b.Velocity != tc.vb {
				t.Fatalf("non-approaching pair impulsed: %+v %+v", a.Velocity, b.Velocity)
			}
			closeFloat(t, b.Position.Sub(a.Position).Len(), 2*RobotRadius)
		})
	}
	t.Run("coincident_has_no_normal", func(t *testing.T) {
		s := NewSim(42, []uint32{1, 2}, nil)
		s.robots[0].Position, s.robots[0].Velocity = Vec2{}, Vec2{5, 0}
		s.robots[1].Position, s.robots[1].Velocity = Vec2{}, Vec2{-5, 0}
		s.softCollide()
		if s.robots[0].Velocity != (Vec2{5, 0}) || s.robots[1].Velocity != (Vec2{-5, 0}) {
			t.Fatal("coincident pair received an impulse")
		}
		if !s.robots[0].Position.finite() || !s.robots[1].Position.finite() {
			t.Fatal("coincident separation produced nonfinite positions")
		}
	})
	t.Run("dead_robot_immune", func(t *testing.T) {
		s, a, b := knockFixture(Vec2{9, 0}, Vec2{})
		b.State = Dead
		s.softCollide()
		if b.Position != (Vec2{0.5, 0}) || a.Velocity != (Vec2{9, 0}) || a.Position != (Vec2{-0.5, 0}) {
			t.Fatalf("dead robot participated in collision: %+v %+v", a, b)
		}
	})
}

func TestKnockbackRepeatedImpactsLoseKineticEnergy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		va, vb Vec2
	}{
		{"unclamped_closing", Vec2{1.5, 0}, Vec2{-1.5, 0}}, // closing 3
		{"clamped_closing", Vec2{4, 0}, Vec2{-4, 0}},       // closing 8, knock capped
		{"asymmetric_pursuit", Vec2{2, 0}, Vec2{0.5, 0}},   // faster robot chases
	} {
		t.Run(tc.name, func(t *testing.T) {
			for round := 0; round < 25; round++ {
				s, a, b := knockFixture(tc.va, tc.vb)
				inbound := speed2(a.Velocity) + speed2(b.Velocity)
				s.softCollide()
				outbound := speed2(a.Velocity) + speed2(b.Velocity)
				if !(outbound < inbound) {
					t.Fatalf("round %d gained kinetic energy: %.14g -> %.14g", round, inbound, outbound)
				}
				if !a.Velocity.finite() || !b.Velocity.finite() {
					t.Fatal("nonfinite velocity after impact")
				}
				closeFloat(t, b.Position.Sub(a.Position).Len(), 2*RobotRadius)
			}
		})
	}
}

func TestKnockbackCoincidentThreeBodyDeterministic(t *testing.T) {
	run := func() *Sim {
		s := NewSim(7, []uint32{1, 2, 3}, nil)
		velocities := []Vec2{{2, 0}, {-2, 0}, {0, 3}}
		for i := range s.robots {
			s.robots[i].Position, s.robots[i].Velocity = Vec2{}, velocities[i]
		}
		for i := 0; i < 30; i++ {
			s.softCollide()
			for j := range s.robots {
				r := &s.robots[j]
				// Two contacts per tick maximum, each capped at maxKnockSpeed.
				if !r.Position.finite() || !r.Velocity.finite() || r.Velocity.Len() > 3+2*maxKnockSpeed+1e-9 {
					t.Fatalf("iteration %d robot %d unstable: pos %v vel %v", i, r.ID, r.Position, r.Velocity)
				}
			}
		}
		return s
	}
	a, b := run(), run()
	if !reflect.DeepEqual(a.Snapshot(), b.Snapshot()) {
		t.Fatal("coincident three-body resolution diverged between identical runs")
	}
	for i := range a.robots {
		if d := b.robots[i].Position.Sub(a.robots[i].Position); d != (Vec2{}) {
			t.Fatalf("robot %d position diverged: %v vs %v", a.robots[i].ID, a.robots[i].Position, b.robots[i].Position)
		}
	}
}

func TestKnockbackWallAdjacentNoPenetrationOrTeleport(t *testing.T) {
	s := NewSim(42, []uint32{1, 2}, nil)
	if err := s.SetWalls([]Wall{{ID: 10, Min: Vec2{1, -10}, Max: Vec2{2, 10}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{-0.5, 0}, 0); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(2, Vec2{1 - RobotRadius, 0}, 1); err != nil {
		t.Fatal(err)
	}
	s.robots[0].Velocity = Vec2{8, 0}
	start := s.robots[1].Position
	s.softCollide()
	// The pinned robot keeps its boundary contact: pushRobot sweeps the
	// correction, so separation presses it into the wall for zero movement.
	closeFloat(t, s.robots[1].Position.X, 1-RobotRadius)
	closeFloat(t, s.robots[0].Velocity.X, 8-maxKnockSpeed)
	closeFloat(t, s.robots[1].Velocity.X, maxKnockSpeed)
	for i := 0; i < 49; i++ {
		s.softCollide()
		if x := s.robots[1].Position.X; x > 1-RobotRadius+1e-9 {
			t.Fatalf("iteration %d: penetrated wall at x=%.14g", i+2, x)
		}
		if d := s.robots[1].Position.Sub(start).Len(); d > 3*RobotRadius+1e-9 {
			t.Fatalf("iteration %d: teleported %.14g m", i+2, d)
		}
		if !s.robots[0].Position.finite() || !s.robots[1].Position.finite() {
			t.Fatalf("iteration %d: nonfinite position", i+2)
		}
	}
	// Sustained shoving through full ticks: input-driven movement, impulses and
	// wall sweeps together must never push the pinned robot out of the world.
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000})
	for i := 0; i < 120; i++ {
		s.Tick()
		a, b := s.robots[0], s.robots[1]
		if !a.Position.finite() || !b.Position.finite() || !a.Velocity.finite() || !b.Velocity.finite() {
			t.Fatalf("tick %d: nonfinite state", i+1)
		}
		if b.Position.X > 1-RobotRadius+1e-9 || b.Position.X < -1e-9 {
			t.Fatalf("tick %d: pinned robot left its wall contact: %.14g", i+1, b.Position.X)
		}
		if a.Position.X >= b.Position.X {
			t.Fatalf("tick %d: presser crossed the pinned robot", i+1)
		}
	}
}

func TestKnockbackReplayAndCheckpointEquality(t *testing.T) {
	runMatch := func(sink EventSink) (*Sim, Checkpoint) {
		s := NewSim(42, []uint32{1, 2}, sink)
		if err := s.SetSpawn(1, Vec2{-2.5, 0}, 0); err != nil {
			t.Fatal(err)
		}
		if err := s.SetSpawn(2, Vec2{2.5, 0}, 1); err != nil {
			t.Fatal(err)
		}
		var middle Checkpoint
		maxKnock := 0.0
		for tick := uint32(1); tick <= 240; tick++ {
			switch tick {
			case 1:
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove | AxisAbility), MoveX: 1000, Dash: true})
				s.ApplyInput(2, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: -1000})
			case 90:
				s.ApplyInput(2, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove), MoveX: 1000})
			case 150:
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove), MoveX: -1000})
			}
			before := s.robots[1].Velocity
			s.Tick()
			// Robot 2 never dashes and accelerates at most 0.4 m/s per tick, so
			// any larger jump is a real knock: the fixture must produce one.
			if jump := s.robots[1].Velocity.Sub(before).Len(); jump > maxKnock {
				maxKnock = jump
			}
			if tick == 120 {
				middle = s.Snapshot()
			}
		}
		if maxKnock < 1 {
			t.Fatalf("fixture produced no measurable knock: %.14g", maxKnock)
		}
		return s, middle
	}
	first, _ := runMatch(&recordingSink{})
	second, _ := runMatch(&recordingSink{})
	if snapshotsDiffer(first, second) {
		t.Fatal("knock match diverged between identical runs")
	}

	var buf bytes.Buffer
	writer, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s, middle := runMatch(writer)
	if err = writer.Flush(); err != nil {
		t.Fatal(err)
	}
	records, err := ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	for _, cp := range []Checkpoint{*records[0].State, middle} {
		sink := &recordingSink{}
		replay := restoreGameplay(t, cp, sink)
		replayGameplay(t, replay, records, 240)
		want, _ := json.Marshal(s.Snapshot())
		got, _ := json.Marshal(replay.Snapshot())
		if !bytes.Equal(want, got) {
			t.Fatalf("replay state diverged from checkpoint tick %d\nwant %s\ngot %s", cp.Tick, want, got)
		}
		expected := []*ombv1.ServerEvent{}
		for _, rec := range records {
			if rec.Event != nil && rec.Event.Tick > cp.Tick {
				expected = append(expected, rec.Event)
			}
		}
		// Length + per-event compare: marshaling would distinguish a nil replay
		// slice (null) from an empty expectation ([]), and this checkpoint's tail
		// legitimately contains no events.
		if len(expected) != len(sink.events) {
			t.Fatalf("replay event count from tick %d: want %d got %d", cp.Tick, len(expected), len(sink.events))
		}
		for i := range expected {
			if expected[i].String() != sink.events[i].String() {
				t.Fatalf("replay event %d diverged from tick %d: %v vs %v", i, cp.Tick, expected[i], sink.events[i])
			}
		}
	}
}

func TestKnockbackCrowdDoesNotCreateEnergy(t *testing.T) {
	s := NewSim(42, []uint32{1, 2, 3, 4}, nil)
	energy := func() float64 {
		total := 0.0
		for _, r := range s.robots {
			total += speed2(r.Velocity)
		}
		return total
	}
	for i := range s.robots {
		s.robots[i].Position = Vec2{X: float64(i)*0.2 - 0.3}
		s.robots[i].Velocity = Vec2{X: 0.3 - float64(i)*0.2}
	}
	before := energy()
	s.softCollide()
	if after := energy(); after > before+1e-12 {
		t.Fatalf("crowd collision created kinetic energy: %.12g -> %.12g", before, after)
	}
	momentum := Vec2{}
	for _, r := range s.robots {
		momentum = momentum.Add(r.Velocity)
	}
	if momentum.Len() > 1e-12 {
		t.Fatalf("equal-mass collision changed total momentum: %+v", momentum)
	}
}

func TestKnockbackDecaysWithoutInput(t *testing.T) {
	s, a, b := knockFixture(Vec2{4, 0}, Vec2{})
	s.softCollide()
	start, speed := b.Position, b.Velocity.Len()
	if speed <= 0 {
		t.Fatal("stationary robot received no knockback")
	}
	// Leave the knocked robot alone, measuring existing acceleration damping
	// through full ticks rather than calling softCollide repeatedly.
	a.State = Dead
	for i := 0; i < 30; i++ {
		s.Tick()
		next := s.robots[1].Velocity.Len()
		if next > speed+1e-12 {
			t.Fatalf("tick %d: velocity grew without input %.12g -> %.12g", i+1, speed, next)
		}
		speed = next
	}
	if speed != 0 {
		t.Fatalf("robot still sliding after half a second: %.12g", speed)
	}
	if moved := s.robots[1].Position.Sub(start).Len(); moved <= 0 || moved > 0.2 {
		t.Fatalf("knockback drift %.12g outside (0, 0.2]m", moved)
	}
}

func TestKnockbackKeepsLockedCoreAndArenaSolid(t *testing.T) {
	for _, tc := range []struct {
		name                      string
		pinned, pusher, direction Vec2
	}{
		{"locked_core", Vec2{28.6, 0}, Vec2{29.5, 0}, Vec2{-1, 0}},
		{"arena", Vec2{79.4, 0}, Vec2{78.5, 0}, Vec2{1, 0}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := arenaSim(t, 3, 1, 2)
			// gameMap's lock has radius 28, matching production mapgen.
			s.mapDef.CoreZone.Radius = 28
			for i, pos := range []Vec2{tc.pusher, tc.pinned} {
				if err := s.SetSpawn(uint32(i+1), pos, 0); err != nil {
					t.Fatal(err)
				}
			}
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove | AxisAbility), MoveX: int32(tc.direction.X * 1000), Dash: true})
			for tick := 0; tick < 120; tick++ {
				s.Tick()
				for _, r := range s.robots {
					if radius := r.Position.Len(); radius < 28.6-1e-9 || radius > 79.4+1e-9 {
						t.Fatalf("tick %d robot %d crossed a solid boundary at radius %.12g", tick, r.ID, radius)
					}
					if r.HP != MaxHP {
						t.Fatal("robot collision caused damage")
					}
				}
				if tick == 0 && s.robots[0].Combat.DashUntil <= s.tick {
					t.Fatal("robot collision cancelled dash")
				}
			}
		})
	}
}

func TestKnockbackLegacyCheckpointKeepsPositionOnlyCollision(t *testing.T) {
	s, _, _ := knockFixture(Vec2{3, 0}, Vec2{-3, 0})
	cp := s.Snapshot()
	if cp.SimulationVersion != SimulationVersion {
		t.Fatal("new checkpoint lacks current simulation version")
	}
	cp.SimulationVersion = 0 // absent in recordings before contact impulses
	raw, err := json.Marshal(cp)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("simulation_version")) {
		t.Fatal("legacy fixture must omit simulation_version")
	}
	legacy := restoreGameplay(t, cp, nil)
	legacy.softCollide()
	if legacy.robots[0].Velocity != (Vec2{3, 0}) || legacy.robots[1].Velocity != (Vec2{-3, 0}) {
		t.Fatal("legacy recording acquired new contact physics")
	}
	closeFloat(t, legacy.robots[1].Position.Sub(legacy.robots[0].Position).Len(), 2*RobotRadius)
}

func TestKnockbackLogRejectsUnknownSimulationVersions(t *testing.T) {
	for _, version := range []int{-1, SimulationVersion + 1} {
		cp := NewSim(42, []uint32{1}, nil).Snapshot()
		cp.SimulationVersion = version
		var buf bytes.Buffer
		log, err := NewMatchEventLogWriter(&buf)
		if err != nil {
			t.Fatal(err)
		}
		log.OnMatchInit(cp)
		if log.Err() == nil {
			t.Fatalf("writer accepted simulation version %d", version)
		}
		raw, err := json.Marshal(diskRecord{Type: RecordTypeDiskName(RecordMatchStart), State: &cp})
		if err != nil {
			t.Fatal(err)
		}
		stream := append([]byte("{\"schema_version\":1}\n"), append(raw, '\n')...)
		if _, err := ReadMatchEventLog(bytes.NewReader(stream)); err == nil {
			t.Fatalf("reader accepted simulation version %d", version)
		}
	}
}
