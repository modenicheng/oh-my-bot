package sim

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func TestHiddenWallsDoNotSplitVisibleBoundary(t *testing.T) {
	for _, center := range []Vec2{{32, 0}, {32, 3}, {32, -3}} {
		world := WorldView{Frame: FrameView{Phase: PhaseOuterRing, Map: &MapDef{CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}}, Robots: []RobotView{{ID: 1, Pos: center}}}
		baseline, _ := world.Observe(1)
		world.Frame.Map.Walls = []Wall{{Min: Vec2{20, 1}, Max: Vec2{21, 2}}}
		observation, _ := world.Observe(1)
		if !reflect.DeepEqual(baseline.Frame.Map.Boundaries, observation.Frame.Map.Boundaries) {
			t.Fatalf("hidden wall changed boundary segmentation for observer %+v", center)
		}
		for _, edge := range observation.Frame.Map.Boundaries {
			if edge.End.Sub(edge.Start).Len() > 1 {
				t.Fatalf("boundary tessellation lost: %+v", edge)
			}
		}
	}
}

func TestLocalPerceptionHidesAllWorldCategories(t *testing.T) {
	world := WorldView{Frame: FrameView{Phase: PhaseCoreOpen, Map: &MapDef{Seed: 938, MapHash: "secret", Walls: []Wall{{ID: 9, Min: Vec2{4, -3}, Max: Vec2{5, 40}}}}},
		Robots:      []RobotView{{ID: 1}, {ID: 2, Pos: Vec2{8, 0}}},
		Cores:       []CoreView{{ID: 1, Pos: Vec2{8, 0}, Alive: true}, {ID: 2, Pos: Vec2{0, 30}, Alive: true}},
		Uplinks:     []UplinkView{{ID: 1, Pos: Vec2{8, 0}}},
		HealthPacks: []HealthPackView{{ID: 1, Pos: Vec2{8, 0}}},
		PointDrops:  []PointDropView{{ID: 1, Pos: Vec2{8, 0}}}}
	observation, found := world.Observe(1)
	if !found || len(observation.Robots) != 1 || len(observation.Cores)+len(observation.Uplinks)+len(observation.HealthPacks)+len(observation.PointDrops) != 0 {
		t.Fatalf("hidden entities leaked: %+v", observation)
	}
	if observation.Frame.Map.Seed != 0 || observation.Frame.Map.MapHash != "" {
		t.Fatal("generation metadata leaked")
	}
	for _, wall := range observation.Frame.Map.Walls {
		if wall.Max.Y > 20 || wall.Max.X > 4.02 {
			t.Fatalf("hidden wall bounds leaked: %+v", wall)
		}
	}
}

func TestLocalMapPreservesPublicUnlockPhaseWithoutGeometry(t *testing.T) {
	world := WorldView{Frame: FrameView{Phase: PhaseOuterRing, Map: &MapDef{CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}}, Robots: []RobotView{{ID: 1, Pos: Vec2{60, 0}}}}
	observation, _ := world.Observe(1)
	if observation.Frame.Map.CoreZone.UnlockPhase != PhaseCoreOpen || observation.Frame.Map.CoreZone.Radius != 0 {
		t.Fatalf("invalid public phase metadata: %+v", observation.Frame.Map.CoreZone)
	}
}

func TestLocalBoundaryOcclusionAndUnlock(t *testing.T) {
	world := WorldView{Frame: FrameView{Phase: PhaseOuterRing, Map: &MapDef{CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}, Walls: []Wall{{Min: Vec2{29, -50}, Max: Vec2{30, 50}}}}}, Robots: []RobotView{{ID: 1, Pos: Vec2{32, 0}}}}
	observation, _ := world.Observe(1)
	if len(observation.Frame.Map.Boundaries) != 0 {
		t.Fatal("boundary behind wall leaked")
	}
	world.Frame.Map.Walls = nil
	world.Frame.Phase = PhaseCoreOpen
	observation, _ = world.Observe(1)
	if len(observation.Frame.Map.Boundaries) != 0 {
		t.Fatal("unlocked boundary still rendered")
	}
}

func TestLocalMapIncludesOnlyVisibleBoundarySegments(t *testing.T) {
	for _, sample := range []struct {
		name   string
		center Vec2
		kind   string
	}{{"arena", Vec2{79, 0}, "arena"}, {"lock", Vec2{32, 0}, "lock"}} {
		t.Run(sample.name, func(t *testing.T) {
			world := WorldView{Frame: FrameView{Phase: PhaseOuterRing, Map: &MapDef{GeneratorVer: 2, ArenaRadius: 80, CoreZone: CoreZoneDef{Radius: 28, UnlockPhase: PhaseCoreOpen}}}, Robots: []RobotView{{ID: 1, Pos: sample.center}}}
			observation, _ := world.Observe(1)
			raw, _ := json.Marshal(observation.Frame.Map)
			var local struct {
				Boundaries []struct {
					Kind       string `json:"kind"`
					Start, End Vec2
				} `json:"boundaries"`
			}
			if err := json.Unmarshal(raw, &local); err != nil {
				t.Fatal(err)
			}
			if len(local.Boundaries) == 0 {
				t.Fatal("physical boundary disappeared")
			}
			for _, edge := range local.Boundaries {
				if edge.Kind != sample.kind || edge.Start.Sub(sample.center).Len() > VisionRadius+1e-6 || edge.End.Sub(sample.center).Len() > VisionRadius+1e-6 {
					t.Fatalf("hidden boundary leaked: %+v", edge)
				}
				if math.Abs(edge.Start.Len()-map[string]float64{"arena": 80, "lock": 28}[edge.Kind]) > 1e-6 {
					t.Fatalf("wrong boundary: %+v", edge)
				}
			}
			if observation.Frame.Map.ArenaRadius != 0 || observation.Frame.Map.CoreZone.Radius != 0 {
				t.Fatal("full boundary geometry leaked")
			}
		})
	}
}
