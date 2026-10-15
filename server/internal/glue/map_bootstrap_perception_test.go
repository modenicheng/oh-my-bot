package glue

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
	"github.com/modenicheng/oh-my-bot/server/internal/snapshot"
)

func TestPlayerMapBootstrapKeepsCompleteStaticTerrain(t *testing.T) {
	hub := NewHub()
	room := hub.EnsureRoom("TERRAIN")
	player, messages := bindLogged(t, hub, room, "pilot")
	match, err := NewMatch(room, 42, 1, map[uint64]SessionInfo{player.playerID: {PlayerID: player.playerID, Nick: player.nick, Color: player.color}}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, match) })
	room.mu.Lock()
	match.bootstrapLocked(player)
	room.mu.Unlock()
	var terrain sim.MapDef
	found := false
	for _, sent := range messages.take() {
		bootstrap := sent.msg.GetEvent().GetMapBootstrap()
		if bootstrap == nil {
			continue
		}
		if err := json.Unmarshal([]byte(bootstrap.MapJson), &terrain); err != nil {
			t.Fatal(err)
		}
		found = true
	}
	if !found || terrain.Partial || !reflect.DeepEqual(&terrain, match.mapDef) {
		t.Fatal("player bootstrap must carry the complete authored map")
	}
	world := match.sim.WorldView()
	observation := snapshot.BuildObservation(snapshot.WorldOf(world), match.wallIX, match.robotOf[player.playerID], 0)
	local := observation.Frame.Map
	if local == nil || !local.Partial || local.Seed != 0 || local.MapHash != "" || local.ArenaRadius != 0 || local.CoreZone.Radius != 0 {
		t.Fatalf("rendering bootstrap changed script perception: %+v", local)
	}
	for _, wall := range local.Walls {
		if wall.Min.X != wall.Max.X && wall.Min.Y != wall.Max.Y {
			t.Fatalf("script received complete wall bounds: %+v", wall)
		}
	}
}
