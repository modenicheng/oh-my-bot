package sim

import (
	"math"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// shotsAndImpacts extracts the ordered Shot/ProjectileImpact telemetry of a run.
func shotsAndImpacts(sink *recordingSink) (shots []*ombv1.EvShot, impacts []*ombv1.EvProjectileImpact) {
	for _, ev := range sink.events {
		if sh := ev.GetShot(); sh != nil {
			shots = append(shots, sh)
		}
		if im := ev.GetProjectileImpact(); im != nil {
			impacts = append(impacts, im)
		}
	}
	return shots, impacts
}

// fireOneShot fires exactly once from robot 1 and lets the round finish.
func fireOneShot(s *Sim) {
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisFire), Fire: true})
	s.Tick()
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisFire)})
	stepTicks(s, 20)
}

func TestShotEventEmittedOnFire(t *testing.T) {
	s, sink := enemySim(t)
	wantID := s.Snapshot().NextProjectile
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAim | AxisFire), Aim: math.Pi / 2, Fire: true})
	s.Tick()
	shots, _ := shotsAndImpacts(sink)
	if len(shots) != 1 {
		t.Fatalf("want 1 shot, got %d", len(shots))
	}
	sh := shots[0]
	if sh.Projectile != wantID || sh.Owner != 1 || sh.Heading != float32(math.Pi/2) {
		t.Fatalf("bad shot payload %+v", sh)
	}
	closeFloat(t, sh.At.X, 0)
	closeFloat(t, sh.At.Y, 50)
	// The event reports the muzzle, while the projectile has already stepped.
	closeFloat(t, s.projectiles[0].Pos.Y, 50+ProjectileSpeed*DT)
}

func TestProjectileImpactEventsShieldInvulnerableWallAndMiss(t *testing.T) {
	// Victim at 5m ahead: impact after one step at ~5.0m distance point.
	t.Run("plain_hit", func(t *testing.T) {
		s, sink := enemySim(t)
		s.robots[1].Position = Vec2{5, 50}
		fireOneShot(s)
		_, impacts := shotsAndImpacts(sink)
		if len(impacts) != 1 || impacts[0].Target != 2 || impacts[0].Owner != 1 || impacts[0].Projectile == 0 ||
			impacts[0].Shield || impacts[0].Invulnerable {
			t.Fatalf("bad impact %+v", impacts[0])
		}
		closeFloat(t, impacts[0].At.X, 5-RobotRadius)
		closeFloat(t, impacts[0].At.Y, 50)
	})
	t.Run("shield", func(t *testing.T) {
		s, sink := enemySim(t)
		s.robots[1].Position = Vec2{5, 50}
		s.ApplyInput(2, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Shield: true}) // hold shield up
		fireOneShot(s)
		_, impacts := shotsAndImpacts(sink)
		if len(impacts) != 1 || !impacts[0].Shield || impacts[0].Invulnerable {
			t.Fatalf("bad shield impact %+v", impacts)
		}
		closeFloat(t, s.robots[1].HP, 100-ShotDamage*ShieldDamageScale)
	})
	t.Run("invulnerable", func(t *testing.T) {
		s, sink := enemySim(t)
		s.robots[1].Position = Vec2{5, 50}
		s.robots[1].Combat.Invulnerable = true
		fireOneShot(s)
		_, impacts := shotsAndImpacts(sink)
		if len(impacts) != 1 || !impacts[0].Invulnerable || impacts[0].Shield {
			t.Fatalf("bad invulnerable impact %+v", impacts)
		}
		closeFloat(t, s.robots[1].HP, 100)
	})
	t.Run("wall_block", func(t *testing.T) {
		s, sink := enemySim(t)
		s.walls = []Wall{{ID: 99, Min: Vec2{2, 48}, Max: Vec2{2.01, 52}}}
		fireOneShot(s)
		_, impacts := shotsAndImpacts(sink)
		if len(impacts) != 1 || impacts[0].Target != 0 {
			t.Fatalf("bad wall impact %+v", impacts)
		}
		closeFloat(t, impacts[0].At.X, 2)
	})
	t.Run("miss_expiry_is_silent", func(t *testing.T) {
		s, sink := enemySim(t)
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisFire), Fire: true})
		s.Tick()
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisFire)})
		stepTicks(s, 60)
		_, impacts := shotsAndImpacts(sink)
		if len(impacts) != 0 {
			t.Fatalf("range expiry emitted impact %+v", impacts)
		}
	})
}

func TestSlideReplayDeterministicWithEvents(t *testing.T) {
	runMatch := func() (*Sim, *recordingSink) {
		sink := &recordingSink{}
		s := NewSim(42, []uint32{1, 2}, sink)
		if err := s.SetWalls([]Wall{
			{ID: 10, Min: Vec2{1, -10}, Max: Vec2{2, 10}},
			{ID: 11, Min: Vec2{-3, -6}, Max: Vec2{-2, -4}},
		}); err != nil {
			t.Fatal(err)
		}
		if err := s.SetSpawn(1, Vec2{.38, 0}, 0); err != nil {
			t.Fatal(err)
		}
		if err := s.SetSpawn(2, Vec2{-1.1, -5}, 1); err != nil {
			t.Fatal(err)
		}
		s.robots[0].Velocity = Vec2{3, 4}
		for tick := uint32(1); tick <= 240; tick++ {
			if tick == 1 {
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove | AxisFire), MoveX: 600, MoveY: 800, Fire: true})
				s.ApplyInput(2, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove | AxisAbility), MoveX: 1000, Dash: true})
			}
			if tick == 90 {
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove), MoveX: -1000})
			}
			if tick == 150 {
				s.ApplyInput(2, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove), MoveY: 1000})
			}
			s.Tick()
		}
		return s, sink
	}
	a, aSink := runMatch()
	b, bSink := runMatch()
	if snapshotsDiffer(a, b) {
		t.Fatal("slide match diverged between identical runs")
	}
	for i := range aSink.events {
		if aSink.events[i].String() != bSink.events[i].String() {
			t.Fatalf("event %d differs: %v vs %v", i, aSink.events[i], bSink.events[i])
		}
	}
	wallHits, impacts := 0, 0
	for _, ev := range aSink.events {
		if ev.GetWallHit() != nil {
			wallHits++
		}
		if ev.GetProjectileImpact() != nil {
			impacts++
		}
	}
	if wallHits == 0 || impacts == 0 {
		t.Fatalf("fixture too weak: wallHits=%d impacts=%d", wallHits, impacts)
	}
}

func snapshotsDiffer(a, b *Sim) bool {
	return a.Snapshot().Tick != b.Snapshot().Tick || len(a.Snapshot().Robots) != len(b.Snapshot().Robots) ||
		a.Snapshot().Robots[0].Position != b.Snapshot().Robots[0].Position ||
		a.Snapshot().Robots[1].Position != b.Snapshot().Robots[1].Position ||
		a.Snapshot().Robots[0].Velocity != b.Snapshot().Robots[0].Velocity ||
		a.Snapshot().Robots[1].Velocity != b.Snapshot().Robots[1].Velocity ||
		a.Snapshot().RNG != b.Snapshot().RNG
}

func TestProjectileColorSurvivesWallImpact(t *testing.T) {
	for _, color := range []string{"#a78bfa", "#fbbf24"} {
		t.Run(color, func(t *testing.T) {
			world, sink := enemySim(t)
			world.robots[0].Color = color
			world.walls = []Wall{{ID: 99, Min: Vec2{2, 48}, Max: Vec2{2.01, 52}}}
			world.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisFire), Fire: true})
			world.Tick()
			view := world.WorldView()
			if len(view.Projectiles) != 1 || view.Projectiles[0].Color != color {
				t.Fatalf("missing projectile color: %+v", view.Projectiles)
			}
			world.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisFire)})
			stepTicks(world, 20)
			shots, impacts := shotsAndImpacts(sink)
			if len(shots) != 1 || shots[0].Color != color {
				t.Fatalf("shot color: %+v", shots)
			}
			if len(impacts) != 1 || impacts[0].Color != color || impacts[0].Target != 0 {
				t.Fatalf("wall impact color: %+v", impacts)
			}
		})
	}
}
