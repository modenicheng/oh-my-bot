package nav

import (
	"math"
	"sync"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func testMap(walls ...sim.Wall) *sim.MapDef {
	return &sim.MapDef{GeneratorVer: 2, Walls: walls, CoreZone: sim.CoreZoneDef{Radius: 28, UnlockPhase: sim.PhaseCoreOpen}}
}

func TestDirectionDirectPath(t *testing.T) {
	got := Direction(testMap(), sim.PhaseCoreOpen, sim.Vec2{X: 40}, sim.Vec2{X: 50, Y: 5})
	want := sim.Vec2{X: 10 / math.Hypot(10, 5), Y: 5 / math.Hypot(10, 5)}
	if distance(got, want) > 1e-12 {
		t.Fatalf("direct direction = %+v, want %+v", got, want)
	}
}

func TestDirectionDetoursAroundThinWall(t *testing.T) {
	m := testMap(sim.Wall{ID: 1, Min: sim.Vec2{X: 42, Y: -3}, Max: sim.Vec2{X: 42.05, Y: 3}})
	got := Direction(m, sim.PhaseCoreOpen, sim.Vec2{X: 40}, sim.Vec2{X: 47})
	if got.X >= 0.95 || math.Abs(got.Y) < 0.2 {
		t.Fatalf("thin-wall route did not detour: %+v", got)
	}
}

func TestDirectionRespectsLockedCorePhase(t *testing.T) {
	m := testMap()
	from, target := sim.Vec2{X: 40}, sim.Vec2{X: -40}
	wantFirst := Direction(m, sim.PhaseOuterRing, from, target)
	if wantFirst.X >= -0.1 || math.Abs(wantFirst.Y) < 0.1 {
		t.Fatalf("locked core route should take a clear detour: %+v", wantFirst)
	}
	const step = 0.25
	pos := from
	for i := 0; i < 1000 && pos.Sub(target).Len() > step; i++ {
		d := Direction(m, sim.PhaseOuterRing, pos, target)
		if i == 0 && d != wantFirst {
			t.Fatalf("locked route changed first step: got %+v want %+v", d, wantFirst)
		}
		if d == (sim.Vec2{}) {
			t.Fatalf("locked route stopped before target at step %d: %+v", i, pos)
		}
		next := pos.Add(d.Scale(step))
		if !segmentFree(m, true, pos, next) {
			t.Fatalf("locked route entered inflated core at step %d: %+v -> %+v", i, pos, next)
		}
		pos = next
	}
	if pos.Sub(target).Len() > step {
		t.Fatalf("locked route did not reach target: final=%+v", pos)
	}
	open := Direction(m, sim.PhaseCoreOpen, from, target)
	if open.X > -0.999 || math.Abs(open.Y) > 1e-12 {
		t.Fatalf("open core route should be direct: %+v", open)
	}
}

func TestDirectionBoundaryAndUnreachableTargetStable(t *testing.T) {
	m := testMap(sim.Wall{ID: 1, Min: sim.Vec2{X: 45, Y: -80}, Max: sim.Vec2{X: 46, Y: 80}})
	from := sim.Vec2{X: 40}
	target := sim.Vec2{X: 100}
	want := Direction(m, sim.PhaseCoreOpen, from, target)
	if want == (sim.Vec2{}) || math.IsNaN(want.X) || math.IsNaN(want.Y) {
		t.Fatalf("unreachable target produced unsafe stop/NaN: %+v", want)
	}
	for i := 0; i < 100; i++ {
		if got := Direction(m, sim.PhaseCoreOpen, from, target); got != want {
			t.Fatalf("query %d changed deterministic fallback: got %+v want %+v", i, got, want)
		}
	}
}

func TestDirectionArrivalStops(t *testing.T) {
	m := testMap()
	if got := Direction(m, sim.PhaseCoreOpen, sim.Vec2{X: 79.39}, sim.Vec2{X: 79.4}); got != (sim.Vec2{}) {
		t.Fatalf("arrival should stop at collision-level distance: %+v", got)
	}
}

func TestDirectionConcurrentDeterminism(t *testing.T) {
	m := testMap(sim.Wall{ID: 1, Min: sim.Vec2{X: 42, Y: -3}, Max: sim.Vec2{X: 42.05, Y: 3}})
	want := Direction(m, sim.PhaseCoreOpen, sim.Vec2{X: 40}, sim.Vec2{X: 47})
	var wg sync.WaitGroup
	errCh := make(chan sim.Vec2, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got := Direction(m, sim.PhaseCoreOpen, sim.Vec2{X: 40}, sim.Vec2{X: 47}); got != want {
				errCh <- got
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for got := range errCh {
		t.Fatalf("concurrent direction = %+v, want %+v", got, want)
	}
}

func TestSixtyFourQueriesWithinTickBudget(t *testing.T) {
	if testing.Short() {
		t.Skip("wall-clock budget check")
	}
	m := testMap(
		sim.Wall{ID: 1, Min: sim.Vec2{X: 10, Y: -55}, Max: sim.Vec2{X: 11, Y: 20}},
		sim.Wall{ID: 2, Min: sim.Vec2{X: -20, Y: -20}, Max: sim.Vec2{X: -19, Y: 55}},
	)
	queries := make([][2]sim.Vec2, 64)
	for i := range queries {
		a := float64(i) * 2 * math.Pi / 64
		queries[i] = [2]sim.Vec2{{X: 65 * math.Cos(a), Y: 65 * math.Sin(a)}, {X: -65 * math.Cos(a), Y: -65 * math.Sin(a)}}
		Direction(m, sim.PhaseOuterRing, queries[i][0], queries[i][1])
	}
	const batches = 20
	bestBatch := time.Hour
	for run := 0; run < 5; run++ {
		start := time.Now()
		for batch := 0; batch < batches; batch++ {
			for _, q := range queries {
				Direction(m, sim.PhaseOuterRing, q[0], q[1])
			}
		}
		if elapsed := time.Since(start); elapsed < bestBatch {
			bestBatch = elapsed
		}
	}
	per64 := bestBatch / batches
	if per64 >= 12*time.Millisecond {
		t.Fatalf("64 cached queries took %v, tick budget is 12ms", per64)
	}
	t.Logf("64 cached navigateTo-style queries: %v (%.1f us/query, %.1fx margin)", per64, float64(per64.Nanoseconds())/64/1000, float64((12*time.Millisecond).Nanoseconds())/float64(per64.Nanoseconds()))
}

func BenchmarkDirection64Cached(b *testing.B) {
	m := testMap(
		sim.Wall{ID: 1, Min: sim.Vec2{X: 10, Y: -55}, Max: sim.Vec2{X: 11, Y: 20}},
		sim.Wall{ID: 2, Min: sim.Vec2{X: -20, Y: -20}, Max: sim.Vec2{X: -19, Y: 55}},
	)
	queries := make([][2]sim.Vec2, 64)
	for i := range queries {
		a := float64(i) * 2 * math.Pi / 64
		queries[i] = [2]sim.Vec2{{X: 65 * math.Cos(a), Y: 65 * math.Sin(a)}, {X: -65 * math.Cos(a), Y: -65 * math.Sin(a)}}
		Direction(m, sim.PhaseOuterRing, queries[i][0], queries[i][1])
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, q := range queries {
			Direction(m, sim.PhaseOuterRing, q[0], q[1])
		}
	}
}

func distance(a, b sim.Vec2) float64 { return math.Hypot(a.X-b.X, a.Y-b.Y) }
