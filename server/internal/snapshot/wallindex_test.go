package snapshot

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestWallIndexSurfaceVisibleMatchesEndpointTolerance(t *testing.T) {
	walls := []sim.Wall{{ID: 1, Min: sim.Vec2{X: 4, Y: -1}, Max: sim.Vec2{X: 5, Y: 1}}}
	ix := NewWallIndex(walls, 4)

	if ix.SurfaceVisible(sim.Vec2{}, sim.Vec2{X: 10}) {
		t.Fatal("a wall before the endpoint must block the surface")
	}
	if !ix.SurfaceVisible(sim.Vec2{}, sim.Vec2{X: 4, Y: 1}) {
		t.Fatal("a wall touched only at the endpoint must remain visible")
	}
}

func TestWallIndexWallsNearPreservesSourceOrderAndFiltersBroadPhase(t *testing.T) {
	walls := []sim.Wall{
		{ID: 10, Min: sim.Vec2{X: 30, Y: -1}, Max: sim.Vec2{X: 31, Y: 1}},
		{ID: 11, Min: sim.Vec2{X: 4, Y: -1}, Max: sim.Vec2{X: 5, Y: 1}},
		{ID: 12, Min: sim.Vec2{X: -6, Y: 5}, Max: sim.Vec2{X: -5, Y: 6}},
	}
	ix := NewWallIndex(walls, 4)
	got := ix.WallsNear(sim.Vec2{}, 8)
	if len(got) != 2 || got[0].ID != 11 || got[1].ID != 12 {
		t.Fatalf("near walls = %+v, want source-order IDs [11 12]", got)
	}
	if got := ix.WallsNear(sim.Vec2{}, 0); len(got) != 0 {
		t.Fatalf("zero-radius query returned %+v", got)
	}
}
