package script

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func healthPackTestFrame() sim.ScriptFrame {
	frame := testFrame()
	frame.Obs.HealthPacks = []sim.HealthPackView{
		{ID: 1, Pos: sim.Vec2{X: 30, Y: 30}, Available: true},
		{ID: 2, Pos: sim.Vec2{X: -30, Y: 30}, Available: false, RespawnInS: 12},
		{ID: 3, Pos: sim.Vec2{X: -30, Y: -30}, Available: true},
		{ID: 4, Pos: sim.Vec2{X: 30, Y: -30}, Available: false, RespawnInS: 1},
	}
	return frame
}

func TestScanHealthPacksExposePublicState(t *testing.T) {
	src := `function tick(bot) {
  const packs = bot.scan().healthPacks;
  if (!Array.isArray(packs) || packs.length !== 4) throw new Error("health packs missing");
  if (packs[0].id !== 1 || packs[0].x !== 30 || packs[0].y !== 30 || !packs[0].available || packs[0].respawnInS !== 0) throw new Error("available pack wrong");
  if (packs[1].id !== 2 || packs[1].x !== -30 || packs[1].y !== 30 || packs[1].available || packs[1].respawnInS !== 12) throw new Error("cooldown pack wrong");
  if (Object.prototype.hasOwnProperty.call(packs[0], "robot") || Object.prototype.hasOwnProperty.call(packs[0], "holder")) throw new Error("dynamic robot leaked");
}`
	if _, err := loadAndTick(t, src, healthPackTestFrame()); err != nil {
		t.Fatal(err)
	}
}

func TestScanHealthPacksNotSharedMutable(t *testing.T) {
	src := `function tick(bot) {
  const first = bot.scan().healthPacks;
  first[0].id = 99; first[0].x = 999; first[1].available = true; first[1].respawnInS = 0; first.pop();
  const again = bot.scan().healthPacks;
  if (again.length !== 4 || again[0].id !== 1 || again[0].x !== 30 || again[1].available || again[1].respawnInS !== 12) {
    throw new Error("shared mutable health pack leaked: " + JSON.stringify(again));
  }
}`
	if _, err := loadAndTick(t, src, healthPackTestFrame()); err != nil {
		t.Fatal(err)
	}
}

func TestScanHealthPacksEmptyWithNilMap(t *testing.T) {
	frame := testFrame()
	frame.Obs.Frame.Map = nil
	frame.Obs.HealthPacks = nil
	if _, err := loadAndTick(t, `function tick(bot) {
  const packs = bot.scan().healthPacks;
  if (!Array.isArray(packs) || packs.length !== 0) throw new Error("nil health packs not []");
  if (!Array.isArray(bot.scan().walls) || bot.scan().walls.length !== 0) throw new Error("nil map walls not []");
}`, frame); err != nil {
		t.Fatal(err)
	}
}
