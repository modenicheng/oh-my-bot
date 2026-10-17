package mapgen

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestCoverPlacementPreservesValidSeedWalls(t *testing.T) {
	// Hash only walls, captured from v10: the v11 metadata intentionally
	// changes MapHash, but successful candidate searches must keep geometry.
	for _, tc := range []struct {
		players int
		hash    string
	}{
		{1, "88ab00b65d15b5e183bad4678db4a5ee5e2064d83d48c8679ec66618e186cf7d"},
		{50, "f71d86e1a481fd61d4bf815cc8990acdf7ad6244cfb9b5fd96b111069bf41363"},
		{64, "d207d1e2ec1ed4c125501fce78a56d5eac2be01b5a57c4e4904afe7b845e6020"},
		{65, "5054223aae4cc6ed3f624a2ddc9c50e2a89dac279fe20a5a62117405c9c506b2"},
		{96, "216f7b6de5ca0526cdbc2d204b4f90131534b0bbe821e08b79ecba54efca2e7f"},
		{150, "0e68ca9f5af23c06332d26ddf76b6cf9e7b2bcf1b6851fc5c4141bc69722e25b"},
		{200, "b8e2dcf5d2aebe4215f502d4f1e4df07ce523fc913cb45d42f9df5a6579e97f6"},
		{256, "1e93b0ee191cbf436ab397b83937a3f2ef311e8896b66201fe4cf14215b7f2bf"},
	} {
		t.Run(fmt.Sprintf("players=%d", tc.players), func(t *testing.T) {
			def, err := GenerateForPlayers(42, tc.players)
			if err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(def.Walls)
			if err != nil {
				t.Fatal(err)
			}
			if got := fmt.Sprintf("%x", sha256.Sum256(data)); got != tc.hash {
				t.Fatalf("successful v10 wall search changed: hash %s, want %s", got, tc.hash)
			}
		})
	}
}

func TestCoverPlacementExhaustedLattice(t *testing.T) {
	// A real START from Ended exhausted all 49 candidates in stratum 3.
	const seed uint64 = 3731973273936997066
	for _, tc := range []struct{ players, walls int }{
		{1, 80}, {49, 80}, {64, 80}, {65, 80},
		{96, 80}, {150, 104}, {200, 112}, {256, 120},
	} {
		t.Run(fmt.Sprintf("players=%d", tc.players), func(t *testing.T) {
			def, err := GenerateForPlayers(seed, tc.players)
			if err != nil {
				t.Fatalf("seed %d: %v", seed, err)
			}
			if len(def.Walls) != tc.walls {
				t.Fatalf("walls = %d, want %d; cover strata must not be dropped", len(def.Walls), tc.walls)
			}
			for i, wall := range def.Walls {
				for _, pad := range def.CorePads {
					if nearestDist2(wallRect(wall), pad.Pos) < 2.5*2.5-1e-9 {
						t.Fatalf("wall %d blocks pad %d", wall.ID, pad.ID)
					}
				}
				for _, pack := range def.HealthPacks {
					if nearestDist2(wallRect(wall), pack.Pos) < 2.5*2.5-1e-9 {
						t.Fatalf("wall %d blocks health pack %d", wall.ID, pack.ID)
					}
				}
				for _, uplink := range def.Uplinks {
					if nearestDist2(wallRect(wall), uplink.Pos) < 2.2*2.2-1e-9 {
						t.Fatalf("wall %d blocks uplink %d", wall.ID, uplink.ID)
					}
				}
				// Only the adjacent base/stub of an L assembly may overlap.
				for _, other := range def.Walls[:i] {
					if wall.ID == other.ID+1 && positiveOverlap(wallRect(wall), wallRect(other)) {
						continue
					}
					if gap2(wallRect(wall), wallRect(other)) < 2.2*2.2-1e-9 {
						t.Fatalf("walls %d/%d lack clearance", wall.ID, other.ID)
					}
				}
			}
			if !connectivityOK(layoutFor(tc.players), def.Walls) {
				t.Fatal("cover disconnected the arena")
			}
			again, err := GenerateForPlayers(seed, tc.players)
			if err != nil || !reflect.DeepEqual(def, again) {
				t.Fatalf("generation is not deterministic: %v", err)
			}
			ids := make([]uint32, tc.players)
			for i := range ids {
				ids[i] = uint32(i + 1)
			}
			world := sim.NewSim(seed, ids, nil)
			if err := world.SetMap(def); err != nil {
				t.Fatalf("SetMap: %v", err)
			}
			world.Tick()
		})
	}
}
