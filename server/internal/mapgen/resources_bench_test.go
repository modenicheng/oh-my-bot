package mapgen

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func BenchmarkRandomResourceOpening200Players(benchmark *testing.B) {
	definition, err := GenerateForPlayers(42, 200)
	if err != nil {
		benchmark.Fatal(err)
	}
	ids := make([]uint32, 200)
	for index := range ids {
		ids[index] = uint32(index + 1)
	}
	world := sim.NewSim(42, ids, nil)
	if err := world.SetMap(definition); err != nil {
		benchmark.Fatal(err)
	}
	initial := world.Snapshot()
	benchmark.ResetTimer()
	for iteration := 0; iteration < benchmark.N; iteration++ {
		benchmark.StopTimer()
		world, err = sim.RestoreCheckpoint(initial, nil)
		if err != nil {
			benchmark.Fatal(err)
		}
		benchmark.StartTimer()
		world.Tick()
	}
}
