package glue

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestEventsRequireLocalPerception(t *testing.T) {
	world := sim.WorldView{Frame: sim.FrameView{Map: &sim.MapDef{Walls: []sim.Wall{{ID: 1, Min: sim.Vec2{X: 4, Y: -2}, Max: sim.Vec2{X: 5, Y: 2}}}}}, Robots: []sim.RobotView{{ID: 1}, {ID: 2, Pos: sim.Vec2{X: 8}}}}
	for _, event := range []*ombv1.ServerEvent{
		{Kind: &ombv1.ServerEvent_Shot{Shot: &ombv1.EvShot{Owner: 2, At: &ombv1.Vec2{X: 8}}}},
		{Kind: &ombv1.ServerEvent_CorePickup{CorePickup: &ombv1.EvCorePickup{By: 2, CoreId: 99}}},
		{Kind: &ombv1.ServerEvent_PointDropSpawn{PointDropSpawn: &ombv1.EvPointDropSpawn{FromRobot: 2, At: &ombv1.Vec2{X: 8}}}},
	} {
		if eventPerceived(world, 1, event) {
			t.Fatalf("hidden event leaked: %v", event)
		}
	}
}

func TestSimulatedWallContactsReachOnlyVisibleObservers(t *testing.T) {
	sink := &soloBotEvents{}
	world := sim.NewSim(1, []uint32{1, 2}, sink)
	definition := &sim.MapDef{
		Walls:     []sim.Wall{{ID: 1, Min: sim.Vec2{X: 4, Y: -20}, Max: sim.Vec2{X: 5, Y: 20}}},
		CorePads:  []sim.CorePadDef{{ID: 10, Pos: sim.Vec2{X: 20}, Value: 10}},
		Uplinks:   []sim.UplinkDef{{ID: 20, Pos: sim.Vec2{X: 20}, InteractR: 2.5, ActivePhase: sim.PhaseOuterRing}},
		CoreRules: sim.CoreRulesDef{PeriodTicks: 3600, GroupWeights: map[sim.Phase][]float64{sim.PhaseOuterRing: {1}, sim.PhaseCoreOpen: {1}}},
	}
	if err := world.SetMap(definition); err != nil {
		t.Fatal(err)
	}
	if err := world.SetSpawn(1, sim.Vec2{}, 0); err != nil {
		t.Fatal(err)
	}
	if err := world.SetSpawn(2, sim.Vec2{X: 8}, 0); err != nil {
		t.Fatal(err)
	}
	world.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(sim.AxisMove | sim.AxisFire), MoveX: 1000, Fire: true})
	projectileContacts, robotContacts := 0, 0
	for tick := 0; tick < 90; tick++ {
		world.Tick()
		for _, event := range sink.events {
			if event.GetProjectileImpact() == nil && event.GetWallHit() == nil {
				continue
			}
			if !eventPerceived(world.WorldView(), 1, event) || eventPerceived(world.WorldView(), 2, event) {
				t.Fatalf("invalid wall contact delivery: %v", event)
			}
			if event.GetProjectileImpact() != nil {
				projectileContacts++
			} else {
				robotContacts++
			}
		}
		sink.events = nil
	}
	if projectileContacts == 0 || robotContacts == 0 {
		t.Fatalf("fixture missed collisions: projectiles=%d robot=%d", projectileContacts, robotContacts)
	}
}

func TestSurfaceImpactsRemainVisibleWithoutSeeingThroughWalls(t *testing.T) {
	world := sim.WorldView{Frame: sim.FrameView{Map: &sim.MapDef{Walls: []sim.Wall{{ID: 1, Min: sim.Vec2{X: 4, Y: -2}, Max: sim.Vec2{X: 5, Y: 2}}}}}, Robots: []sim.RobotView{{ID: 1}}}
	for _, sample := range []struct {
		x       float64
		visible bool
	}{{4, true}, {4.001, false}, {5, false}, {8, false}, {24, false}} {
		event := &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_ProjectileImpact{ProjectileImpact: &ombv1.EvProjectileImpact{At: &ombv1.Vec2{X: sample.x}}}}
		if got := eventPerceived(world, 1, event); got != sample.visible {
			t.Errorf("impact x=%v: visible=%v want=%v", sample.x, got, sample.visible)
		}
	}
	world.Frame.Map = &sim.MapDef{CoreZone: sim.CoreZoneDef{Radius: 28, UnlockPhase: sim.PhaseCoreOpen}}
	world.Robots[0].Pos = sim.Vec2{X: 32}
	impact := &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_ProjectileImpact{ProjectileImpact: &ombv1.EvProjectileImpact{At: &ombv1.Vec2{X: 28}}}}
	if !eventPerceived(world, 1, impact) {
		t.Fatal("locked boundary swallowed its own impact")
	}
}
