package mapgen

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestRandomResourceSupplyAtRoomSizes(t *testing.T) {
	for _, players := range []int{1, 64, 200, 256} {
		for _, seed := range []uint64{1, 42, 99} {
			t.Run(fmt.Sprintf("players=%d/seed=%d", players, seed), func(t *testing.T) {
				definition, err := GenerateForPlayers(seed, players)
				if err != nil {
					t.Fatal(err)
				}
				ids := make([]uint32, players)
				for index := range ids {
					ids[index] = uint32(index + 1)
				}
				world := sim.NewSim(seed, ids, nil)
				if err := world.SetMap(definition); err != nil {
					t.Fatal(err)
				}
				world.Tick()
				state := world.Snapshot()
				alive, budget := 0, int32(0)
				for index, core := range state.Cores {
					if !core.Alive {
						continue
					}
					alive++
					budget += sim.UpgradePointsFor(core.Value)
					pad := definition.CorePads[index]
					band := definition.CoreRules.SpawnBands[pad.Group]
					if core.Pos == pad.Pos || core.Pos.Len() < band.MinRadius || core.Pos.Len() > band.MaxRadius {
						t.Fatalf("core did not move into its ring: %+v", core)
					}
				}
				for _, drop := range state.PointDrops {
					budget += drop.Points
					if drop.Points != 1 || drop.Pos.Len() < definition.CoreZone.Radius+sim.RobotRadius {
						t.Fatalf("invalid chip: %+v", drop)
					}
				}
				chips := min(alive, (players+3)/4)
				if alive != definition.CoreRules.TargetAlive || budget != int32(alive*2+chips) || len(state.PointDrops) != chips {
					t.Fatalf("supply drift: alive=%d/%d budget=%d chips=%d", alive, definition.CoreRules.TargetAlive, budget, len(state.PointDrops))
				}
				restored, err := sim.RestoreCheckpoint(state, nil)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(state, restored.Snapshot()) {
					t.Fatal("generated resource state failed checkpoint roundtrip")
				}
			})
		}
	}
}
