package script

import (
	"math"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func navigationFrame() sim.ScriptFrame {
	frame := testFrame()
	frame.Self.Pos = sim.Vec2{X: 40}
	frame.Obs.Frame.Phase = sim.PhaseCoreOpen
	frame.Obs.Frame.Map = &sim.MapDef{
		GeneratorVer: 2,
		Walls:        []sim.Wall{{ID: 1, Min: sim.Vec2{X: 42, Y: -3}, Max: sim.Vec2{X: 42.05, Y: 3}}},
		CoreZone:     sim.CoreZoneDef{Radius: 28, UnlockPhase: sim.PhaseCoreOpen},
	}
	return frame
}

func TestNavigateToFlatAndLegacyAlias(t *testing.T) {
	if testing.Short() {
		t.Skip("wall detour pathfinding exceeds the strict tick quota under race instrumentation")
	}
	frame := navigationFrame()
	for _, tc := range []struct{ name, source string }{
		{"flat", `function tick(bot){ bot.navigateTo({x:47,y:0}); }`},
		{"legacy", `function tick(ctx){ ctx.api.navigateTo({x:47,y:0}); }`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd, err := loadAndTick(t, tc.source, frame)
			if err != nil {
				t.Fatal(err)
			}
			if cmd.Move == nil || cmd.Move.X >= 0.95 || math.Abs(cmd.Move.Y) < 0.2 {
				t.Fatalf("navigateTo did not detour around wall: %+v", cmd.Move)
			}
		})
	}
}

func TestMoveToStillUsesStraightLine(t *testing.T) {
	cmd, err := loadAndTick(t, `function tick(bot){ bot.moveTo({x:47,y:0}); }`, navigationFrame())
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Move == nil || cmd.Move.X < 0.999 || math.Abs(cmd.Move.Y) > 1e-12 {
		t.Fatalf("moveTo acquired pathfinding: %+v", cmd.Move)
	}
}

func TestNavigateToReachedTargetStopsExplicitly(t *testing.T) {
	frame := navigationFrame()
	frame.Obs.Frame.Map.Walls = nil
	cmd, err := loadAndTick(t, `function tick(bot){ bot.navigateTo({x:40.01,y:0}); }`, frame)
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Move == nil || *cmd.Move != (sim.Vec2{}) {
		t.Fatalf("navigateTo must explicitly stop at arrival: %+v", cmd.Move)
	}
}
