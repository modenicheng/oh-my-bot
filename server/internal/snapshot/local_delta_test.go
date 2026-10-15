package snapshot

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestLocalMapDeltaAndResourceExit(t *testing.T) {
	encoder := NewEncoder()
	observation := sim.Observation{Frame: sim.FrameView{Map: &sim.MapDef{Version: 1, Partial: true}}, VisionRadius: 20, Uplinks: []sim.UplinkView{{ID: 3}}, HealthPacks: []sim.HealthPackView{{ID: 4}}}
	first := encoder.Encode(1, 0, sim.PhaseOuterRing, 100, observation, nil)
	if first.MapJson == nil || first.GetVisionRadius() != 20 {
		t.Fatal("missing local map/radius")
	}
	observation.Uplinks = nil
	observation.HealthPacks = nil
	next := encoder.Encode(2, 0, sim.PhaseOuterRing, 100, observation, nil)
	if len(next.UplinkGone) != 1 || next.UplinkGone[0] != 3 || len(next.HealthPackGone) != 1 || next.HealthPackGone[0] != 4 {
		t.Fatalf("resource exit not transmitted: %v", next)
	}
	if next.MapJson != nil {
		t.Fatal("unchanged map sent twice")
	}
	encoder.ForceFull()
	if encoder.Encode(3, 0, sim.PhaseOuterRing, 100, observation, nil).MapJson == nil {
		t.Fatal("resync lost map")
	}
}
