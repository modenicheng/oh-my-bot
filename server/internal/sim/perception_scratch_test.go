package sim

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"slices"
	"sync"
	"testing"
)

func TestLocalMapGeometryFingerprint(t *testing.T) {
	world := WorldView{Frame: FrameView{Map: &MapDef{GeneratorVer: 2, ArenaRadius: 80, CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}}}
	for i := 0; i < 112; i++ {
		p := Vec2{float64(i%14)*9 - 63, float64(i/14)*16 - 64}
		world.Frame.Map.Walls = append(world.Frame.Map.Walls, Wall{ID: uint32(i + 1), Min: p, Max: p.Add(Vec2{3, 0.6})})
	}
	hash := sha256.New()
	for _, phase := range []Phase{PhaseOuterRing, PhaseCoreOpen} {
		world.Frame.Phase = phase
		for _, radius := range []float64{20, 32} {
			for i := 0; i < 64; i++ {
				center := Vec2{float64(i%8)*21 - 73, float64(i/8)*21 - 73}
				local := world.localMap(center, radius, world.LineOfSight, world.SurfaceVisible, nil, nil)
				if err := json.NewEncoder(hash).Encode(local); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	const want = "47d297b306ba52ba91dfddb381ac7adb0f8b58fc50211cda3456430fdb3532de"
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		t.Fatalf("geometry fingerprint = %s, want %s", got, want)
	}
}

func TestLocalMapDoesNotAppendIntoSharedCorners(t *testing.T) {
	world := WorldView{Frame: FrameView{Map: &MapDef{CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}}}
	storage := []Vec2{{4, 1}, {5, 2}, {123, 456}, {789, 123}}
	want := slices.Clone(storage)
	visible := func(Vec2, Vec2) bool { return true }
	world.localMap(Vec2{79, 0}, 20, visible, visible, storage[:2], []Wall{})
	if !slices.Equal(storage, want) {
		t.Fatalf("per-observer tangents mutated shared corners: %v", storage)
	}
}

func TestLocalMapReusesPrivateCornerScratch(t *testing.T) {
	world := WorldView{Frame: FrameView{Map: &MapDef{CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}}}
	corners := make([]Vec2, 448)
	visible := func(Vec2, Vec2) bool { return true }
	// No visible surfaces: only the independent output MapDef should allocate.
	allocs := testing.AllocsPerRun(100, func() {
		world.localMap(Vec2{79, 0}, 20, visible, visible, corners, []Wall{})
	})
	if allocs > 1 {
		t.Fatalf("temporary corner copies still allocate: %.0f allocs", allocs)
	}
}

func TestPerceptionScratchNeverAliasesRetainedOutput(t *testing.T) {
	world := WorldView{Frame: FrameView{Map: &MapDef{GeneratorVer: 2, ArenaRadius: 80, CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}, Walls: []Wall{{ID: 1, Min: Vec2{72, 2}, Max: Vec2{74, 3}}}}}}
	center := Vec2{79, 0}
	retained := world.localMap(center, 20, world.LineOfSight, world.SurfaceVisible, nil, nil)
	want := cloneMap(retained)
	// cloneMap normalizes nil slices, so compare geometry slices independently.
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				world.localMap(Vec2{79, float64(i) / 2}, 32, world.LineOfSight, world.SurfaceVisible, nil, nil)
			}
		}(i)
	}
	wg.Wait()
	if !reflect.DeepEqual(retained.Walls, want.Walls) || !reflect.DeepEqual(retained.Boundaries, want.Boundaries) {
		t.Fatal("scratch reuse mutated a retained observation")
	}
}

func BenchmarkLocalMapBoundary(b *testing.B) {
	world := WorldView{Frame: FrameView{Map: &MapDef{GeneratorVer: 2, ArenaRadius: 80, CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}}}
	corners := make([]Vec2, 448)
	for i := range corners {
		corners[i] = Vec2{float64(i%28)*4 - 56, float64(i/28)*6 - 48}
	}
	visible := func(Vec2, Vec2) bool { return true }
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		world.localMap(Vec2{79, 0}, 20, visible, visible, corners, []Wall{})
	}
}
