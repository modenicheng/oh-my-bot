package script

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestScanLocalBoundarySegments(t *testing.T) {
	world := sim.WorldView{Frame: sim.FrameView{Phase: sim.PhaseOuterRing, Map: &sim.MapDef{CoreZone: sim.CoreZoneDef{Radius: 28, UnlockPhase: sim.PhaseCoreOpen}}}, Robots: []sim.RobotView{{ID: 1, Pos: sim.Vec2{X: 32}}}}
	observation, _ := world.Observe(1)
	frame := testFrame()
	frame.Obs = observation
	if _, err := loadAndTick(t, `function tick(ctx) { const edges = ctx.scan().boundaries; if (!edges || edges.length === 0 || edges[0].kind !== 'lock' || edges[0].start.x < 0) throw new Error('visible boundary missing'); }`, frame); err != nil {
		t.Fatal(err)
	}
}
