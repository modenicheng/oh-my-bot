package sim

import (
	"bytes"
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func resourceSim(t *testing.T, seed uint64, sink EventSink) *Sim {
	t.Helper()
	world := NewSim(seed, []uint32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}, sink)
	definition := gameMap()
	definition.GeneratorVer = 10
	definition.ArenaRadius = 80
	definition.CorePads = []CorePadDef{{ID: 100, Pos: Vec2{20, 0}, Value: 10}, {ID: 101, Pos: Vec2{24, 0}, Value: 25}}
	definition.CoreRules.TargetAlive = 2
	definition.CoreRules.SpawnBands = []CoreSpawnBand{{MinRadius: 18, MaxRadius: 27}}
	definition.Walls = []Wall{{ID: 200, Min: Vec2{-4, 19}, Max: Vec2{4, 21}}}
	definition.HealthPacks = []HealthPackDef{{ID: 300, Pos: Vec2{22, 3}}}
	definition.Uplinks = []UplinkDef{{ID: 400, Pos: Vec2{-24, 0}, InteractR: 2.5, ActivePhase: PhaseOuterRing}}
	if err := world.SetMap(definition); err != nil {
		t.Fatal(err)
	}
	if err := world.SetSpawn(1, Vec2{20, 0}, 0); err != nil {
		t.Fatal(err)
	}
	return world
}

func TestRandomResourcesSplitBudgetAndKeepHealthPacksFixed(t *testing.T) {
	for seed := uint64(0); seed < 100; seed++ {
		world := resourceSim(t, seed, nil)
		packs := append([]HealthPack(nil), world.healthPacks...)
		world.Tick()
		if len(world.pointDrops) != 3 {
			t.Fatalf("seed %d: scattered %d chips, want 3", seed, len(world.pointDrops))
		}
		budget := int32(0)
		positions := make([]Vec2, 0, 10)
		for index, core := range world.cores {
			if !core.Alive || core.Pos == world.mapDef.CorePads[index].Pos {
				t.Fatalf("seed %d: core retained its fixed pad: %+v", seed, core)
			}
			budget += world.coreUpgradePoints(core.Value)
			positions = append(positions, core.Pos)
		}
		for _, drop := range world.pointDrops {
			if drop.Points != 1 || drop.GoneAt != 1+PointDropTTL {
				t.Fatalf("invalid ambient chip: %+v", drop)
			}
			budget += drop.Points
			positions = append(positions, drop.Pos)
		}
		if budget != 10 {
			t.Fatalf("SP budget = %d, want reduced 3+7", budget)
		}
		for index, position := range positions {
			if !world.mapDef.CoreRules.SpawnBands[0].contains(position) || !world.freePosition(position) {
				t.Fatalf("illegal resource position: %+v", position)
			}
			for _, previous := range positions[:index] {
				if position.Sub(previous).Len() < 2 {
					t.Fatalf("resources overlap: %+v / %+v", position, previous)
				}
			}
		}
		if !reflect.DeepEqual(packs, world.healthPacks) || world.robots[0].Upg.Points != 0 {
			t.Fatal("health pack moved or resources spawned directly on the robot")
		}
		before := world.Snapshot()
		world.replenishCores()
		if !reflect.DeepEqual(before, world.Snapshot()) {
			t.Fatal("uncollected cores generated another budget")
		}
	}
}

func TestAmbientResourceDensityScalesAndCapsSupply(t *testing.T) {
	for _, players := range []int{1, 4, 16, 64, 200, 256} {
		world := resourceSim(t, 42, nil)
		world.robots = make([]Robot, players)
		for index := range world.robots {
			world.robots[index].State = Dead
		}
		world.spawnPointDrops(Vec2{24, 0}, 9)
		bountyCount := len(world.pointDrops)
		target := (players + 3) / 4
		for wave := 0; wave < target+5; wave++ {
			for index := range world.cores {
				world.cores[index].Alive = false
			}
			world.replenishCores()
		}
		if count := len(world.pointDrops) - bountyCount; count != target {
			t.Fatalf("%d players: ambient count = %d, want cap %d", players, count, target)
		}
		world.tick = PointDropTTL + 1
		for index := range world.cores {
			world.cores[index].Alive = false
		}
		world.replenishCores()
		fresh := 0
		for _, drop := range world.pointDrops {
			if drop.Ambient && drop.GoneAt > world.tick {
				fresh++
			}
		}
		if fresh == 0 || fresh > target {
			t.Fatalf("%d players: expired chips blocked new supply: %d", players, fresh)
		}
	}
}

func TestRandomResourceWavesReplayAndRelocate(t *testing.T) {
	var recording bytes.Buffer
	log, err := NewMatchEventLogWriter(&recording)
	if err != nil {
		t.Fatal(err)
	}
	world := resourceSim(t, 42, log)
	world.Tick()
	restored, err := RestoreCheckpoint(world.Snapshot(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for step := 0; step < 2*TickRate; step++ {
		if step == 2*TickRate-1 {
			input := &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove)}
			world.ApplyInput(1, input)
			restored.ApplyInput(1, input)
		}
		world.Tick()
		restored.Tick()
		if !reflect.DeepEqual(world.Snapshot(), restored.Snapshot()) {
			t.Fatal("checkpoint continuation changed resources or RNG")
		}
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	replayed, err := ReplayTo(bytes.NewReader(recording.Bytes()), world.tick, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(world.Snapshot(), replayed.Snapshot()) {
		t.Fatal("resource log replay diverged")
	}
	frames, err := ReplayVisualFrames(bytes.NewReader(recording.Bytes()), 6)
	if err != nil {
		t.Fatal(err)
	}
	visual := frames[len(frames)-1]
	if visual.Resources == nil || !reflect.DeepEqual(visual.Resources.Cores, world.WorldView().Cores) || len(visual.Resources.PointDrops) != len(world.pointDrops) {
		t.Fatal("browser replay omitted dynamic resources")
	}
	previous := append([]CoreView(nil), world.cores...)
	for index := range world.cores {
		world.cores[index].Alive = false
	}
	world.replenishCores()
	for index, core := range world.cores {
		if !core.Alive || core.Pos == previous[index].Pos {
			t.Fatal("replacement core reused its previous location")
		}
	}
}

func TestAmbientPointDropsPickupExpiryAndVisibility(t *testing.T) {
	sink := &recordingSink{}
	world := resourceSim(t, 42, sink)
	world.Tick()
	drop := world.pointDrops[0]
	robot := &world.robots[0]
	robot.Position, robot.PathStart = drop.Pos, drop.Pos
	world.events = nil
	world.stepPointDrops()
	if robot.Upg.Points != 1 || len(world.pointDrops) != 2 || len(world.events) != 1 || world.events[0].GetPointDropPickup() == nil {
		t.Fatal("ambient chip did not award exactly one SP through the existing pickup channel")
	}
	world.tick = drop.GoneAt
	world.stepPointDrops()
	if len(world.pointDrops) != 0 {
		t.Fatal("ambient chips did not expire")
	}
	world.publishView()
	observation, _ := world.WorldView().Observe(1)
	for _, pad := range observation.Frame.Map.CorePads {
		found := false
		for _, core := range world.cores {
			if core.Alive && pad.ID == core.ID && pad.Pos == core.Pos {
				found = true
			}
		}
		if !found {
			t.Fatal("local perception leaked a fixed pad instead of a live random core")
		}
	}
}

func TestResourceCheckpointRejectsInvalidCorePositions(t *testing.T) {
	world := resourceSim(t, 42, nil)
	world.Tick()
	for _, position := range []Vec2{{}, {100, 0}, {0, 20}, {math.NaN(), 0}} {
		checkpoint := world.Snapshot()
		checkpoint.Cores[0].Pos = position
		if _, err := RestoreCheckpoint(checkpoint, nil); err == nil {
			t.Fatalf("invalid core position accepted: %+v", position)
		}
	}
}

func TestLegacyCoreRewardsAndFixedPositions(t *testing.T) {
	for _, version := range []int{4, 5, 6} {
		world := resourceSim(t, 42, nil)
		world.simulationVersion = version
		world.Tick()
		expected := int32(5)
		if version < 5 {
			expected = 0
		}
		if world.robots[0].Upg.Points != expected || len(world.pointDrops) != 0 {
			t.Fatalf("v%d legacy reward changed", version)
		}
		for index, core := range world.cores {
			if core.Pos != world.mapDef.CorePads[index].Pos {
				t.Fatal("legacy core moved")
			}
		}
	}
}

func TestResourceSpawnBandsValidationAndOwnership(t *testing.T) {
	world := resourceSim(t, 1, nil)
	before := world.Snapshot()
	for _, bands := range [][]CoreSpawnBand{
		{{MinRadius: 27, MaxRadius: 18}},
		{{MinRadius: -1, MaxRadius: 27}},
		{{MinRadius: math.NaN(), MaxRadius: 27}},
		{{MinRadius: 18, MaxRadius: math.Inf(1)}},
		{{MinRadius: 18, MaxRadius: 81}},
		{{MinRadius: 25, MaxRadius: 27}},
	} {
		definition := cloneMap(before.Map)
		definition.CoreRules.SpawnBands = bands
		if err := world.SetMap(definition); err == nil || !reflect.DeepEqual(before, world.Snapshot()) {
			t.Fatal("invalid resource bands accepted or changed simulation")
		}
	}
	definition := cloneMap(before.Map)
	if err := world.SetMap(definition); err != nil {
		t.Fatal(err)
	}
	definition.CoreRules.SpawnBands[0].MinRadius = 999
	if world.mapDef.CoreRules.SpawnBands[0].MinRadius == 999 {
		t.Fatal("spawn band aliases caller input")
	}
}

func TestResourceWaveRejectsBlockedBandWithoutPartialBudget(t *testing.T) {
	world := resourceSim(t, 42, nil)
	world.walls = []Wall{{ID: 200, Min: Vec2{-28, -28}, Max: Vec2{28, 28}}}
	if world.spawnRandomCore(0) || world.cores[0].Alive || len(world.pointDrops) != 0 {
		t.Fatal("blocked wave created a partial core/SP budget")
	}
}

func TestResourcePositionsAreUniformByArea(t *testing.T) {
	world := resourceSim(t, 42, nil)
	world.walls, world.robots, world.healthPacks, world.mapDef.Uplinks = nil, nil, nil, nil
	band := world.mapDef.CoreRules.SpawnBands[0]
	quadrants := [4]int{}
	squaredRadiusTotal := 0.0
	for sample := 0; sample < 4000; sample++ {
		position, ok := world.resourcePosition(band, nil)
		if !ok {
			t.Fatal("empty ring rejected resource placement")
		}
		quadrant := 0
		if position.X < 0 {
			quadrant++
		}
		if position.Y < 0 {
			quadrant += 2
		}
		quadrants[quadrant]++
		squaredRadiusTotal += position.X*position.X + position.Y*position.Y
	}
	for _, count := range quadrants {
		if count < 900 || count > 1100 {
			t.Fatalf("angular bias: %v", quadrants)
		}
	}
	expected := (band.MinRadius*band.MinRadius + band.MaxRadius*band.MaxRadius) / 2
	if math.Abs(squaredRadiusTotal/4000-expected) > 5 {
		t.Fatalf("radial bias: mean r^2=%.2f, want %.2f", squaredRadiusTotal/4000, expected)
	}
}

func TestRandomResourcesRespectCoreZoneUnlock(t *testing.T) {
	world := resourceSim(t, 42, nil)
	definition := cloneMap(world.mapDef)
	definition.CoreRules.SpawnBands = append(definition.CoreRules.SpawnBands, CoreSpawnBand{MaxRadius: 4})
	definition.CorePads = append(definition.CorePads, CorePadDef{ID: 102, Pos: Vec2{2, 0}, Group: 1, Value: 25})
	definition.CoreRules.TargetAlive = 3
	definition.CoreRules.GroupWeights[PhaseOuterRing] = []float64{0, 1}
	definition.CoreRules.GroupWeights[PhaseCoreOpen] = []float64{0, 1}
	if err := world.SetMap(definition); err != nil {
		t.Fatal(err)
	}
	if world.spawnCore() || len(world.pointDrops) != 0 {
		t.Fatal("resources spawned in the locked core zone")
	}
	world.tick = CoreOpenTick - 1
	world.Tick()
	core := world.cores[2]
	if !core.Alive || core.Pos.Len() > 4 || len(world.pointDrops) != 2 {
		t.Fatal("central Mega supply did not unlock with its scattered SP budget")
	}
	for _, drop := range world.pointDrops {
		if drop.Pos.Len() > 4 || drop.Points != 1 {
			t.Fatal("central budget left its own spawn band")
		}
	}
	if _, err := RestoreCheckpoint(world.Snapshot(), nil); err != nil {
		t.Fatal(err)
	}
}
