package snapshot

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestSingleShotGenerationAlwaysPresentInOwnerSelf(t *testing.T) {
	encoder := NewEncoder()
	for tick := uint32(1); tick <= 3; tick++ {
		self := SelfInput{Robot: sim.RobotView{ID: 1}, InputGeneration: tick + 10}
		delta := encoder.Encode(tick, 0, sim.PhaseOuterRing, 10, sim.Observation{}, &self)
		if delta.Self.InputGeneration == nil || *delta.Self.InputGeneration != tick+10 {
			t.Fatal("missing generation in full/delta")
		}
	}
	if delta := encoder.Encode(4, 0, sim.PhaseOuterRing, 10, sim.Observation{}, nil); delta.Self != nil {
		t.Fatal("spectator received owner state")
	}
}
