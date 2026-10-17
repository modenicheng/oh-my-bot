package sim

import (
	"math"
	"math/rand"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// Keep the pre-broad-phase algorithm as an independent replay-equivalence oracle.
func sweptReachReference(s *Sim, start, end, center Vec2, itemR float64) bool {
	touches := func(p Vec2) bool {
		return p.Sub(center).Len() <= RobotRadius+itemR+collisionEpsilon && s.LineOfSight(p, center)
	}
	if touches(start) || touches(end) {
		return true
	}
	if c := s.sweepContact(start, end.Sub(start)); c.hit && c.t < 1-collisionEpsilon {
		end = start.Add(end.Sub(start).Scale(max(0, c.t)))
	}
	d := end.Sub(start)
	l := d.Len()
	if l <= collisionEpsilon {
		return false
	}
	t := math.Max(0, math.Min(1, ((center.X-start.X)*d.X+(center.Y-start.Y)*d.Y)/(l*l)))
	return touches(start.Add(d.Scale(t)))
}

func pickupPerfSim() *Sim {
	s := NewSim(1, []uint32{1}, nil)
	s.walls = []Wall{{ID: 1, Min: Vec2{4, -10}, Max: Vec2{5, 10}}, {ID: 2, Min: Vec2{-8, 3}, Max: Vec2{-4, 4}}}
	s.mapDef = &MapDef{GeneratorVer: 2, ArenaRadius: 80, CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}
	s.rebuildWallIndex()
	return s
}

func TestSweptReachBroadPhaseMatchesReference(t *testing.T) {
	s := pickupPerfSim()
	rng := rand.New(rand.NewSource(3200))
	for _, phase := range []Phase{PhaseOuterRing, PhaseCoreOpen} {
		s.phase = ombv1.Phase(phase)
		for i := 0; i < 6000; i++ {
			start := Vec2{rng.Float64()*160 - 80, rng.Float64()*160 - 80}
			end := start.Add(Vec2{rng.Float64()*20 - 10, rng.Float64()*20 - 10})
			center := start.Add(Vec2{rng.Float64()*40 - 20, rng.Float64()*40 - 20})
			radius := CoreRadius
			if i%2 == 0 {
				radius = HealthPackRadius
			}
			// Exact endpoint tangencies and tiny offsets must survive the broad phase.
			if i%3 == 0 {
				end = start
				center = end.Add(Vec2{X: RobotRadius + radius + float64(i%5-2)*collisionEpsilon})
			}
			got := s.sweptReach(start, end, center, radius)
			if want := sweptReachReference(s, start, end, center, radius); got != want {
				t.Fatalf("phase=%v start=%v end=%v center=%v radius=%v: got %v want %v", phase, start, end, center, radius, got, want)
			}
		}
	}
}

func TestDistantPickupSkipsWallQueryAllocations(t *testing.T) {
	s := pickupPerfSim()
	allocs := testing.AllocsPerRun(100, func() {
		if s.sweptReach(Vec2{3, 0}, Vec2{3.2, 0}, Vec2{60, 60}, CoreRadius) {
			panic("distant item reached")
		}
	})
	if allocs != 0 {
		t.Fatalf("distant pickup still performs allocating wall queries: %.0f allocs", allocs)
	}
}

func BenchmarkPickupReach200(b *testing.B) {
	s := pickupPerfSim()
	starts := make([]Vec2, 200)
	items := make([]Vec2, 128)
	for i := range starts {
		starts[i] = Vec2{float64(i%20)*6 - 60, float64(i/20)*6 - 30}
	}
	for i := range items {
		items[i] = Vec2{float64(i%16)*8 - 64, float64(i/16)*8 - 32}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		for _, start := range starts {
			for _, item := range items {
				s.sweptReach(start, start.Add(Vec2{X: 0.1}), item, CoreRadius)
			}
		}
	}
}
