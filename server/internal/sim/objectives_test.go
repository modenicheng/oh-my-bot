package sim

import (
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func TestMapLockedZoneMovementProjectilesAndSight(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(5, []uint32{1}, sink)
	m := gameMap()
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{-6, 0}, 0); err != nil {
		t.Fatal(err)
	}
	if s.LineOfSight(Vec2{-6, 0}, Vec2{6, 0}) || s.WorldView().LineOfSight(Vec2{-6, 0}, Vec2{6, 0}) {
		t.Fatal("locked zone allowed sight")
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove | AxisFire), MoveX: 1000, Fire: true})
	stepTicks(s, 60)
	closeFloat(t, s.robots[0].Position.X, -5.6)
	if len(s.projectiles) != 0 {
		t.Fatal("projectiles crossed locked zone")
	}
	if err := s.SetMap(m); err == nil {
		t.Fatal("map changed after match start")
	}
	s.tick = CoreOpenTick - 1
	s.Tick()
	if s.Phase() != ombv1.Phase_CORE_OPEN || s.View().Tick != 14400 || s.View().TimeLeftS != 240 {
		t.Fatal("phase did not change at 4:00")
	}
	if !s.LineOfSight(Vec2{-6, 0}, Vec2{6, 0}) || !s.WorldView().LineOfSight(Vec2{-6, 0}, Vec2{6, 0}) || s.robots[0].Position.X <= -5.6 {
		t.Fatal("zone not immediately unlocked")
	}
	found := false
	for _, ev := range sink.events {
		if phase := ev.GetPhaseChange(); phase != nil && ev.Tick == 14400 {
			found = true
		}
	}
	if !found {
		t.Fatal("missing phase event")
	}
	s.projectiles = []Projectile{{ID: 999, Owner: 1, Pos: Vec2{-5.1, 0}}}
	s.stepProjectiles()
	if len(s.projectiles) != 1 || s.projectiles[0].Pos.X <= -5 {
		t.Fatal("unlocked zone still blocks projectile")
	}
}

func TestMapValidationCopiesAndTransactionalSpawns(t *testing.T) {
	s := NewSim(17, []uint32{1, 2}, nil)
	m := gameMap()
	m.CorePads = []CorePadDef{{ID: 99, Pos: Vec2{20, 0}, Value: 10, Group: 0}}
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	before := s.Snapshot()
	m.CoreRules.GroupWeights[PhaseOuterRing][0] = 999
	m.CorePads[0].Value = 25
	m.Sectors[0].SpawnArea = Rect{}
	if s.View().Map.CorePads[0].Value != 10 || s.View().Map.CoreRules.GroupWeights[PhaseOuterRing][0] != 1 {
		t.Fatal("map aliases caller")
	}
	for _, tc := range []struct {
		name   string
		mutate func(*MapDef)
	}{
		{"nan_radius", func(m *MapDef) { m.CoreZone.Radius = math.NaN() }},
		{"negative_weight", func(m *MapDef) { m.CoreRules.GroupWeights[PhaseOuterRing][0] = -1 }},
		{"missing_group", func(m *MapDef) { m.CorePads[0].Group = 5 }},
		{"zero_period", func(m *MapDef) { m.CoreRules.PeriodTicks = 0 }},
		{"bad_wall", func(m *MapDef) { m.Walls = []Wall{{ID: 50, Min: Vec2{5, 5}, Max: Vec2{4, 4}}} }},
		{"blocked_spawn", func(m *MapDef) { m.Sectors[0].SpawnArea = Rect{Min: Vec2{-1, -1}, Max: Vec2{1, 1}} }},
		{"bad_uplink", func(m *MapDef) { m.Uplinks = []UplinkDef{{ID: 99, InteractR: 0, ActivePhase: PhaseOuterRing}} }},
		{"health_outside_arena", func(m *MapDef) {
			m.GeneratorVer = 5
			m.HealthPacks = []HealthPackDef{{ID: 90, Pos: Vec2{X: 1000}}}
		}},
		{"health_center_without_robot_clearance", func(m *MapDef) {
			m.GeneratorVer = 5
			m.HealthPacks = []HealthPackDef{{ID: 90, Pos: Vec2{X: 80 - RobotRadius/2}}}
		}},
		{"health_nonfinite", func(m *MapDef) {
			m.HealthPacks = []HealthPackDef{{ID: 90, Pos: Vec2{X: math.Inf(1)}}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := cloneMap(before.Map)
			tc.mutate(bad)
			if err := s.SetMap(bad); err == nil {
				t.Fatal("bad map accepted")
			}
			if !reflect.DeepEqual(before, s.Snapshot()) {
				t.Fatal("failed map changed state or RNG")
			}
		})
	}
	twin := NewSim(17, []uint32{2, 1}, nil)
	if err := twin.SetMap(before.Map); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, twin.Snapshot()) {
		t.Fatal("map spawn not deterministic")
	}
	for _, r := range s.robots {
		if !before.Map.Sectors[r.Sector].SpawnArea.Contains(r.Position) {
			t.Fatal("spawn outside sector")
		}
	}
}

func uplinkSim(t *testing.T) (*Sim, *recordingSink) {
	t.Helper()
	s, sink := enemySim(t)
	m := gameMap()
	m.Uplinks = []UplinkDef{{ID: 100, Pos: Vec2{20, 0}, InteractR: 2.5, ActivePhase: PhaseOuterRing}, {ID: 101, Pos: Vec2{30, 0}, InteractR: 2.5, ActivePhase: PhaseOuterRing}, {ID: 102, Pos: Vec2{}, InteractR: 2.5, Main: true, ActivePhase: PhaseCoreOpen}}
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{20, 0}, 0); err != nil {
		t.Fatal(err)
	}
	return s, sink
}
func countHacks(sink *recordingSink) []*ombv1.EvUplinkHack {
	out := []*ombv1.EvUplinkHack{}
	for _, ev := range sink.events {
		if h := ev.GetUplinkHack(); h != nil {
			out = append(out, h)
		}
	}
	return out
}
func TestUplinkEightSecondsAndIndependentCooldowns(t *testing.T) {
	s, sink := uplinkSim(t)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
	stepTicks(s, 479)
	if len(countHacks(sink)) != 0 || s.uplinks[0].ProgressTicks != 479 {
		t.Fatal("uplink scored before 8 seconds")
	}
	s.Tick()
	hacks := countHacks(sink)
	if len(hacks) != 1 || hacks[0].By != 1 || hacks[0].UplinkId != 100 || hacks[0].Value != 15 {
		t.Fatalf("wrong hack %+v", hacks)
	}
	if s.UplinkViews()[0].PersonalCDs[1] != 30 || s.uplinks[0].ReadyAt[1] != 2280 {
		t.Fatal("personal cooldown not 30s")
	}
	s.robots[0].Position = Vec2{30, 0}
	s.robots[1].Position = Vec2{20, 0}
	s.ApplyInput(2, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
	stepTicks(s, 480)
	hacks = countHacks(sink)
	if len(hacks) != 3 || hacks[1].By != 2 || hacks[1].UplinkId != 100 || hacks[2].By != 1 || hacks[2].UplinkId != 101 {
		t.Fatalf("station/player cooldowns not independent %+v", hacks)
	}
	s.robots[1].Position = Vec2{60, 0}
	s.robots[0].Position = Vec2{20, 0}
	advance(s, 2279)
	if s.uplinks[0].ProgressTicks != 0 {
		t.Fatal("personal CD bypassed")
	}
	s.Tick()
	if s.uplinks[0].ProgressTicks != 1 {
		t.Fatal("CD did not expire at tick 2280")
	}
	s.Respawn(1)
	s.Tick()
	if s.uplinks[1].ReadyAt[1] != 2760 {
		t.Fatal("death erased personal CD")
	}
}
func TestUplinkInterruptionsAndMainActivation(t *testing.T) {
	for _, kind := range []string{"leave", "fire", "death", "release", "hit"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := uplinkSim(t)
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
			stepTicks(s, 120)
			switch kind {
			case "leave":
				s.robots[0].Position = Vec2{23, 0}
			case "fire":
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisFire), Fire: true})
			case "death":
				s.damage(2, &s.robots[0], 100)
			case "release":
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisAbility)})
			case "hit":
				s.damage(2, &s.robots[0], 12)
			}
			s.Tick()
			want := uint32(120)
			if kind == "hit" {
				want = 121
			}
			if s.uplinks[0].ProgressTicks != want {
				t.Fatalf("%s progress %d want %d", kind, s.uplinks[0].ProgressTicks, want)
			}
			if kind != "hit" && s.uplinks[0].DecayAt != s.tick+HackInterruptGrace {
				t.Fatalf("%s decay tick %d want %d", kind, s.uplinks[0].DecayAt, s.tick+HackInterruptGrace)
			}
		})
	}
	t.Run("retained progress grace decay and resume", func(t *testing.T) {
		s, _ := uplinkSim(t)
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
		stepTicks(s, 180)
		s.robots[0].Position = Vec2{23, 0}
		s.Tick()
		if s.uplinks[0].ProgressTicks != 180 || s.uplinks[0].HackingID != 0 {
			t.Fatalf("interruption did not retain progress: %+v", s.uplinks[0])
		}
		stepTicks(s, HackInterruptGrace-1)
		if s.uplinks[0].ProgressTicks != 180 {
			t.Fatal("progress decayed during 0.5s grace")
		}
		s.Tick()
		if s.uplinks[0].ProgressTicks != 150 || s.uplinks[0].DecayAt != s.tick+HackDecayInterval {
			t.Fatalf("first decay wrong at tick %d: %+v", s.tick, s.uplinks[0])
		}
		stepTicks(s, HackDecayInterval-1)
		if s.uplinks[0].ProgressTicks != 150 {
			t.Fatal("progress decayed before one-second cadence")
		}
		s.robots[0].Position = Vec2{20, 0}
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisAbility), Interact: true})
		s.Tick()
		if s.uplinks[0].ProgressTicks != 151 || s.uplinks[0].HackingID != 1 || s.uplinks[0].DecayAt != 0 {
			t.Fatalf("retained progress did not resume: %+v", s.uplinks[0])
		}
	})

	t.Run("checkpoint restores retained decay cadence", func(t *testing.T) {
		s, _ := uplinkSim(t)
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
		stepTicks(s, 180)
		s.robots[0].Position = Vec2{23, 0}
		s.Tick()
		cp := s.Snapshot()
		restored, err := RestoreCheckpoint(cp, nil)
		if err != nil {
			t.Fatal(err)
		}
		stepTicks(restored, HackInterruptGrace)
		if restored.uplinks[0].ProgressTicks != 150 || restored.uplinks[0].DecayAt != restored.tick+HackDecayInterval {
			t.Fatalf("restored decay cadence diverged: %+v", restored.uplinks[0])
		}
	})

	t.Run("legacy checkpoints still clear immediately", func(t *testing.T) {
		s, _ := uplinkSim(t)
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
		stepTicks(s, 120)
		cp := s.Snapshot()
		cp.SimulationVersion = 2
		legacy, err := RestoreCheckpoint(cp, nil)
		if err != nil {
			t.Fatal(err)
		}
		legacy.robots[0].Position = Vec2{23, 0}
		legacy.Tick()
		if legacy.uplinks[0].ProgressTicks != 0 || legacy.uplinks[0].DecayAt != 0 {
			t.Fatalf("legacy interruption retained progress: %+v", legacy.uplinks[0])
		}
	})

	s, sink := uplinkSim(t)
	if s.UplinkViews()[2].Active {
		t.Fatal("main active before 4:00")
	}
	s.tick = CoreOpenTick - 1
	s.robots[0].Position = Vec2{}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
	stepTicks(s, 480)
	hacks := countHacks(sink)
	if len(hacks) != 1 || hacks[0].UplinkId != 102 || hacks[0].Value != 25 || !s.UplinkViews()[2].Active {
		t.Fatalf("main hack not +25 %+v", hacks)
	}
}
func TestCorePeriodsWeightsPickupsAndPhaseChange(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(5, []uint32{1}, sink)
	m := gameMap()
	m.CorePads = []CorePadDef{{ID: 50, Pos: Vec2{20, 0}, Group: 0, Value: 10}, {ID: 51, Pos: Vec2{}, Group: 1, Value: 25}}
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{20, 0}, 0); err != nil {
		t.Fatal(err)
	}
	s.Tick()
	pickups := []*ombv1.EvCorePickup{}
	for _, ev := range sink.events {
		if p := ev.GetCorePickup(); p != nil {
			pickups = append(pickups, p)
		}
	}
	if len(pickups) != 1 || pickups[0].Value != 10 || pickups[0].CoreId != 50 || s.cores[0].Alive {
		t.Fatalf("initial core pickup %+v", pickups)
	}
	s.robots[0].Position = Vec2{25, 0}
	advance(s, 59)
	if s.cores[0].Alive {
		t.Fatal("core refreshed before period")
	}
	s.Tick()
	if !s.cores[0].Alive || s.cores[1].Alive {
		t.Fatal("outer group weights ignored")
	}
	s.cores[0].Alive = false
	s.tick = CoreOpenTick - 1
	s.robots[0].Position = Vec2{}
	s.Tick()
	if s.cores[0].Alive || s.cores[1].Alive {
		t.Fatal("central pickup or outer weight wrong")
	}
	p := sink.events[len(sink.events)-1].GetCorePickup()
	if p == nil || p.Value != 25 || p.CoreId != 51 {
		t.Fatalf("mega pickup not +25 %+v", p)
	}
	s.robots[0].Position = Vec2{25, 0}
	stepTicks(s, 60)
	if s.cores[0].Alive || !s.cores[1].Alive {
		t.Fatal("4:00 weights did not move centrally")
	}
}
func TestCoreWeightedSelectionDeterministic(t *testing.T) {
	m := gameMap()
	m.CoreZone.Radius = 0
	m.CoreRules.GroupWeights[PhaseOuterRing] = []float64{1, 3}
	m.CorePads = []CorePadDef{{ID: 50, Pos: Vec2{20, 0}, Group: 0, Value: 10}, {ID: 51, Pos: Vec2{22, 0}, Group: 1, Value: 25}}
	a, b := NewSim(87, nil, nil), NewSim(87, nil, nil)
	if err := a.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err := b.SetMap(m); err != nil {
		t.Fatal(err)
	}
	counts := [2]int{}
	for i := 0; i < 4000; i++ {
		a.spawnCore()
		b.spawnCore()
		if !reflect.DeepEqual(a.cores, b.cores) {
			t.Fatal("weighted refresh not deterministic")
		}
		for j := range a.cores {
			if a.cores[j].Alive {
				counts[j]++
			}
			a.cores[j].Alive, b.cores[j].Alive = false, false
		}
	}
	if counts[0]+counts[1] != 4000 || counts[1] < 2800 || counts[1] > 3200 {
		t.Fatalf("weight distribution outside tolerance %v", counts)
	}
}

// Swept pickup boundary table: tangency inclusive, just-outside miss, no
// absorption through walls or a locked zone, dash-speed paths still collect.
func TestSweptPickupBoundaries(t *testing.T) {
	newPickupSim := func(walls []Wall) *Sim {
		s := NewSim(11, []uint32{1}, nil)
		m := gameMap()
		m.HealthPacks = []HealthPackDef{{ID: 1, Pos: Vec2{X: 10, Y: 0}}}
		m.CorePads = []CorePadDef{{ID: 50, Pos: Vec2{X: -10, Y: 0}, Group: 0, Value: 10}}
		m.CoreRules.GroupWeights = map[Phase][]float64{PhaseOuterRing: {1}, PhaseCoreOpen: {1}}
		m.Walls = walls
		if err := s.SetMap(m); err != nil {
			t.Fatal(err)
		}
		if err := s.SetSpawn(1, Vec2{X: 20, Y: 0}, 0); err != nil {
			t.Fatal(err)
		}
		s.robots[0].HP = 50
		return s
	}
	place := func(s *Sim, x float64) {
		s.robots[0].Position, s.robots[0].PathStart = Vec2{X: x, Y: 0}, Vec2{X: x, Y: 0}
	}
	heals := func(s *Sim) int {
		n := 0
		for _, ev := range s.events {
			if ev.GetHeal() != nil {
				n++
			}
		}
		return n
	}

	t.Run("tangent_edge_inclusive", func(t *testing.T) {
		s := newPickupSim(nil)
		place(s, 10+RobotRadius+HealthPackRadius) // exact tangency
		s.stepHealthPacks()
		if heals(s) != 1 || s.healthPacks[0].ReadyAt != HealthPackCooldown || s.robots[0].HP != 80 {
			t.Fatalf("tangency not picked up: heals=%d hp=%.1f", heals(s), s.robots[0].HP)
		}
	})
	t.Run("just_outside_misses", func(t *testing.T) {
		s := newPickupSim(nil)
		place(s, 10+RobotRadius+HealthPackRadius+0.01)
		s.stepHealthPacks()
		if s.healthPacks[0].ReadyAt != 0 || s.robots[0].HP != 50 {
			t.Fatal("picked up beyond combined radius")
		}
	})
	t.Run("wall_blocks_within_pickup_radius", func(t *testing.T) {
		s := newPickupSim(nil)
		s.walls = []Wall{{ID: 90, Min: Vec2{X: 10.4, Y: -2}, Max: Vec2{X: 10.5, Y: 2}}}
		place(s, 10+RobotRadius+HealthPackRadius)
		s.stepHealthPacks()
		if heals(s) != 0 || s.healthPacks[0].ReadyAt != 0 {
			t.Fatal("picked up through wall despite blocked sight")
		}
	})
	t.Run("locked_zone_blocks_nearby_core", func(t *testing.T) {
		s := newPickupSim(nil)
		s.cores = []CoreView{{ID: 50, Pos: Vec2{X: -4.9, Y: 0}, Value: 10, Alive: true}}
		place(s, -s.mapDef.CoreZone.Radius-RobotRadius)
		s.stepCores()
		if !s.cores[0].Alive {
			t.Fatal("nearby core absorbed through locked-zone boundary")
		}
		s.phase = ombv1.Phase_CORE_OPEN
		s.stepCores()
		if s.cores[0].Alive {
			t.Fatal("unlocked core within pickup radius was not collected")
		}
	})
	t.Run("slide_endpoint_still_collects", func(t *testing.T) {
		s := newPickupSim(nil)
		s.walls = []Wall{{ID: 90, Min: Vec2{X: 10, Y: 0}, Max: Vec2{X: 12, Y: 2}}}
		start, end := Vec2{X: 9.2, Y: 1}, Vec2{X: 11, Y: -0.7}
		if !s.sweptReach(start, end, Vec2{X: 11, Y: -1.5}, HealthPackRadius) {
			t.Fatal("legal slide endpoint contact lost when its chord crosses a corner")
		}
	})
	t.Run("dash_path_collects", func(t *testing.T) {
		s := newPickupSim(nil)
		// One tick at dash speed crosses the pack: start 0.2 before overlap,
		// end 0.2 after. Neither endpoint alone is inside combined radius.
		s.robots[0].PathStart = Vec2{X: 10 + RobotRadius + HealthPackRadius + 0.2, Y: 0}
		s.robots[0].Position = Vec2{X: 10 - RobotRadius - HealthPackRadius - 0.2, Y: 0}
		s.stepHealthPacks()
		if heals(s) != 1 || s.robots[0].HP != 80 {
			t.Fatalf("dash path skipped pack: heals=%d hp=%.1f", heals(s), s.robots[0].HP)
		}
	})
	t.Run("full_health_and_single_consumer", func(t *testing.T) {
		s := NewSim(11, []uint32{1, 2}, &recordingSink{})
		m := gameMap()
		m.HealthPacks = []HealthPackDef{{ID: 1, Pos: Vec2{X: 10, Y: 0}}}
		if err := s.SetMap(m); err != nil {
			t.Fatal(err)
		}
		for i := range s.robots {
			s.robots[i].Position, s.robots[i].PathStart = Vec2{X: 10, Y: 0}, Vec2{X: 10, Y: 0}
		}
		s.robots[0].HP = MaxHP // full: must not consume
		s.robots[1].HP = 40
		s.stepHealthPacks()
		h1, h2 := s.robots[0].HP, s.robots[1].HP
		if h1 != MaxHP || h2 != 70 || s.healthPacks[0].ReadyAt != HealthPackCooldown {
			t.Fatalf("full-health or multi-consumer leak: h1=%.1f h2=%.1f ready=%d", h1, h2, s.healthPacks[0].ReadyAt)
		}
	})
}
