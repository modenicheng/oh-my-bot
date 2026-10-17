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
