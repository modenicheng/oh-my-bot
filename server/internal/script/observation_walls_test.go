package script

import (
	"math"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 静态墙是公开地图结构（挡移动+弹丸+视线），不属于按感知裁剪的动态实体，
// 因此 scan().walls 必须完整返回全部墙的 AABB（min/max），不随视野半径或
// 遮挡裁剪，也不泄露任何隐藏机器人/弹丸信息。
func TestScanWallsExposed(t *testing.T) {
	frame := testFrame()
	frame.Obs.Frame.Map = &sim.MapDef{
		Seed: 42,
		Walls: []sim.Wall{
			{ID: 100, Min: sim.Vec2{X: -2, Y: -1}, Max: sim.Vec2{X: 2, Y: 1}},
			{ID: 101, Min: sim.Vec2{X: 8, Y: 9}, Max: sim.Vec2{X: 12, Y: 11}},
		},
	}
	src := `
let got = null;
function tick(ctx) {
  const walls = ctx.scan().walls;
  if (!walls || walls.length !== 2) throw new Error("walls missing: " + JSON.stringify(walls));
  for (const w of walls) {
    if (!isFinite(w.min.x) || !isFinite(w.min.y) || !isFinite(w.max.x) || !isFinite(w.max.y)) {
      throw new Error("non-finite wall aabb");
    }
  }
  if (walls[0].id !== 100 || walls[0].min.x !== -2 || walls[0].max.y !== 1) throw new Error("wall0 shape wrong");
  if (walls[1].id !== 101 || walls[1].min.x !== 8 || walls[1].max.y !== 11) throw new Error("wall1 shape wrong");
  got = true;
}
`
	if _, err := loadAndTick(t, src, frame); err != nil {
		t.Fatalf("tick: %v", err)
	}
}

// 长墙即使中心远超视野半径，其近侧面仍须完整可见（静态公开信息不裁剪）。
func TestScanWallsLongWallPartiallyOutsideVision(t *testing.T) {
	frame := testFrame()
	frame.Obs.Frame.Map = &sim.MapDef{
		Seed: 42,
		Walls: []sim.Wall{
			{ID: 200, Min: sim.Vec2{X: -60, Y: 5}, Max: sim.Vec2{X: 60, Y: 7}}, // 中心 (0,6) 距离 6 但长 120m
		},
	}
	src := `
function tick(ctx) {
  const walls = ctx.scan().walls;
  if (!walls || walls.length !== 1) throw new Error("long wall truncated: " + (walls && walls.length));
  const w = walls[0];
  if (w.min.x !== -60 || w.max.x !== 60 || w.min.y !== 5 || w.max.y !== 7) throw new Error("aabb altered");
}
`
	if _, err := loadAndTick(t, src, frame); err != nil {
		t.Fatalf("tick: %v", err)
	}
}

// 无墙地图（len(Walls)==0）：walls 必须是空数组而非 undefined，避免脚本
// 每处都写防御代码。
func TestScanWallsEmptyMap(t *testing.T) {
	frame := testFrame()
	frame.Obs.Frame.Map = &sim.MapDef{Seed: 7} // 无墙
	src := `
function tick(ctx) {
  const walls = ctx.scan().walls;
  if (!Array.isArray(walls) || walls.length !== 0) throw new Error("walls not empty array: " + typeof walls);
}
`
	if _, err := loadAndTick(t, src, frame); err != nil {
		t.Fatalf("tick: %v", err)
	}
}

// 脚本改写返回的 walls 不得影响后续 tick（不得别名共享地图）。
func TestScanWallsNotSharedMutable(t *testing.T) {
	frame := testFrame()
	frame.Obs.Frame.Map = &sim.MapDef{
		Seed: 42,
		Walls: []sim.Wall{{ID: 300, Min: sim.Vec2{X: 1}, Max: sim.Vec2{X: 2, Y: 3}}},
	}
	src := `
function tick(ctx) {
  const w0 = ctx.scan().walls[0];
  w0.min.x = 999; w0.max.y = -999; w0.id = 1;
  const again = ctx.scan().walls[0];
  if (again.min.x !== 1 || again.max.y !== 3 || again.id !== 300) {
    throw new Error("shared mutable wall leaked: " + JSON.stringify(again));
  }
}
`
	if _, err := loadAndTick(t, src, frame); err != nil {
		t.Fatalf("tick: %v", err)
	}
}

// mapSeed 仍保持稳定（回归：墙暴露不得破坏现有 GameInfo）。
func TestScanWallsDontBreakMapSeed(t *testing.T) {
	frame := testFrame()
	src := `
function tick(ctx) {
  if (ctx.game.mapSeed !== 42) throw new Error("mapSeed changed: " + ctx.game.mapSeed);
  if (ctx.scan().walls === undefined) throw new Error("walls undefined");
}
`
	if _, err := loadAndTick(t, src, frame); err != nil {
		t.Fatalf("tick: %v", err)
	}
	_ = math.Pi
}
