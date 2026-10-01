package snapshot

import (
	"reflect"
	"slices"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- 测试基建 ----

func mkWall(id, x0, y0, x1, y1 float64) sim.Wall {
	return sim.Wall{ID: uint32(id), Min: sim.Vec2{X: x0, Y: y0}, Max: sim.Vec2{X: x1, Y: y1}}
}

func mkRobot(id uint32, x, y float64) sim.RobotView {
	return sim.RobotView{ID: id, Pos: sim.Vec2{X: x, Y: y}, HpX10: 1000, EnergyX10: 600, Nick: "r", Color: "#fff"}
}

func mkWorld(walls []sim.Wall, robots []sim.RobotView) World {
	m := &sim.MapDef{Walls: walls}
	return World{
		FrameView: sim.FrameView{Tick: 1, Phase: sim.PhaseOuterRing, TimeLeftS: 480, Map: m},
		Robots:    robots,
	}
}

func idsOf(rs []sim.RobotView) []uint32 {
	out := make([]uint32, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.ID)
	}
	return out
}

// ---- BuildObservation：视野半径 ----

func TestVisionRadius(t *testing.T) {
	w := mkWorld(nil, []sim.RobotView{
		mkRobot(1, 0, 0), mkRobot(2, 19.9, 0), mkRobot(3, 20.1, 0), mkRobot(4, 20, 0),
	})
	obs := BuildObservation(w, nil, 1, 0)
	// 19.9 在内；20.1 超界；恰 20m 边界在内（中心距 ≤ 20）。
	want := []uint32{1, 2, 4}
	if got := idsOf(obs.Robots); !slices.Equal(got, want) {
		t.Fatalf("visible robots = %v, want %v", got, want)
	}
	pulse := BuildObservation(w, nil, 1, 0, 32)
	if got := idsOf(pulse.Robots); !slices.Equal(got, []uint32{1, 2, 3, 4}) {
		t.Fatalf("pulse vision = %v, want all robots within 32m", got)
	}
}

// ---- 墙体遮挡 ----

func TestWallOcclusion(t *testing.T) {
	// 观察者 (0,0)，目标 (10,0)，中间竖墙 x∈[4,5]。
	walls := []sim.Wall{mkWall(1, 4, -1, 5, 1)}
	w := mkWorld(walls, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	obs := BuildObservation(w, NewWallIndex(walls, 0), 1, 0)
	if got := idsOf(obs.Robots); !slices.Equal(got, []uint32{1}) {
		t.Fatalf("墙后目标应不可见：got %v", got)
	}

	// 同距离但无墙 → 可见（对照）。
	w2 := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	obs2 := BuildObservation(w2, NewWallIndex(nil, 0), 1, 0)
	if got := idsOf(obs2.Robots); !slices.Equal(got, []uint32{1, 2}) {
		t.Fatalf("无墙应可见：got %v", got)
	}
}

func TestWallGapVisible(t *testing.T) {
	// 墙有缝：y∈[1,∞) 与 y∈(-∞,-1]，视线 (0,0)→(10,0) 穿缝而过 → 可见。
	walls := []sim.Wall{mkWall(1, 4, 1, 5, 9), mkWall(2, 4, -9, 5, -1)}
	w := mkWorld(walls, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	obs := BuildObservation(w, NewWallIndex(walls, 0), 1, 0)
	if got := idsOf(obs.Robots); !slices.Equal(got, []uint32{1, 2}) {
		t.Fatalf("穿缝视线应可见：got %v", got)
	}
}

// ---- Deprecated partner IDs do not change visibility ----

func TestDeprecatedPartnerDoesNotBypassVision(t *testing.T) {
	walls := []sim.Wall{mkWall(1, 4, -10, 5, 10)}
	w := mkWorld(walls, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 60, 0)})
	obs := BuildObservation(w, NewWallIndex(walls, 0), 1, 2)
	if got := idsOf(obs.Robots); !slices.Equal(got, []uint32{1}) {
		t.Fatalf("deprecated partner ID bypassed wall/range: got %v", got)
	}
	if obs.PartnerID != 0 || obs.IsPartner(2) {
		t.Fatalf("deprecated partner marker remains live: %+v", obs)
	}
}

func TestHealthPacksArePublicMapObjects(t *testing.T) {
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	w.HealthPacks = []sim.HealthPackView{{ID: 3, Pos: sim.Vec2{X: 60, Y: 60}, Available: false, RespawnInS: 12}}
	obs := BuildObservation(w, nil, 1, 0)
	if len(obs.HealthPacks) != 1 || obs.HealthPacks[0] != w.HealthPacks[0] {
		t.Fatalf("health packs missing from player observation: %+v", obs.HealthPacks)
	}
	spec := BuildSpectatorObservation(w)
	if len(spec.HealthPacks) != 1 || spec.HealthPacks[0] != w.HealthPacks[0] {
		t.Fatalf("health packs missing from spectator observation: %+v", spec.HealthPacks)
	}
}

// ---- Core/Uplink 恒全量 ----

func TestMapObjectsAlwaysFull(t *testing.T) {
	// Core/Uplink 放在 100m 外 + 墙后，仍全量下发。
	walls := []sim.Wall{mkWall(1, 4, -10, 5, 10)}
	w := mkWorld(walls, []sim.RobotView{mkRobot(1, 0, 0)})
	w.Cores = []sim.CoreView{{ID: 10, Pos: sim.Vec2{X: 100, Y: 100}, Value: 25, Alive: true}}
	w.Uplinks = []sim.UplinkView{{
		ID: 20, Pos: sim.Vec2{X: -100, Y: -100}, Active: true,
		PersonalCDs: map[uint32]uint32{1: 12, 2: 5},
	}}
	obs := BuildObservation(w, NewWallIndex(walls, 0), 1, 0)
	if len(obs.Cores) != 1 || obs.Cores[0].ID != 10 {
		t.Fatalf("Core 应恒全量：got %+v", obs.Cores)
	}
	if len(obs.Uplinks) != 1 {
		t.Fatalf("Uplink 应恒全量：got %d", len(obs.Uplinks))
	}
	// PersonalCDs 收敛为仅观察者条目。
	if got := obs.Uplinks[0].PersonalCDs; !reflect.DeepEqual(got, map[uint32]uint32{1: 12}) {
		t.Fatalf("PersonalCDs 应只剩观察者条目：got %v", got)
	}
}

// ---- Projectile 同规则裁剪 ----

func TestProjectileClipping(t *testing.T) {
	walls := []sim.Wall{mkWall(1, 4, -10, 5, 10)}
	w := mkWorld(walls, []sim.RobotView{mkRobot(1, 0, 0)})
	w.Projectiles = []sim.ProjView{
		{ID: 30, Owner: 2, Pos: sim.Vec2{X: 5, Y: 0}},  // 墙内（弹丸本身在墙里）
		{ID: 31, Owner: 2, Pos: sim.Vec2{X: 10, Y: 0}}, // 墙后
		{ID: 32, Owner: 2, Pos: sim.Vec2{X: 5, Y: 2}},  // 缝上方？y=2 在墙 y 范围 [ -10,10] 内 → 视线过墙 → 不可见
		{ID: 33, Owner: 2, Pos: sim.Vec2{X: 5, Y: 15}}, // 视线绕过墙端 → 可见
	}
	obs := BuildObservation(w, NewWallIndex(walls, 0), 1, 0)
	want := []uint32{33}
	got := make([]uint32, 0, len(obs.Projectiles))
	for _, p := range obs.Projectiles {
		got = append(got, p.ID)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("projectile 裁剪 = %v, want %v", got, want)
	}
}

// ---- 观察者不在场时退化为原点视野 ----

func TestMissingObserverFallback(t *testing.T) {
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 30, 0)})
	obs := BuildObservation(w, nil, 99, 0) // 99 不存在
	if got := idsOf(obs.Robots); !slices.Equal(got, []uint32{1}) {
		t.Fatalf("原点视野应只含 20m 内的 1 号：got %v", got)
	}
}

// ---- 视线穿过墙角边界（精确性） ----

func TestSegmentAABBCornerCases(t *testing.T) {
	// 线段恰好擦过墙角 (4,1)：从 (0,0) 到 (8,2)——斜率恒定 y=x/4，x=4 时 y=1 恰在角上。
	// slab 法含边界，判定为相交（遮挡）——保守取向，漏视比多视安全。
	ix := NewWallIndex([]sim.Wall{mkWall(1, 4, 1, 5, 9)}, 0)
	if ix.Visible(sim.Vec2{X: 0, Y: 0}, sim.Vec2{X: 8, Y: 2}) {
		t.Fatal("擦墙角视线应判为被遮挡（保守）")
	}
	// 端点在墙内部：可见性判定按线段整段处理——端点入墙即相交。
	if ix.Visible(sim.Vec2{X: 0, Y: 0}, sim.Vec2{X: 4.5, Y: 1.5}) {
		t.Fatal("终点在墙内的视线应被拦截")
	}
	// 完全在墙一侧、不接触。
	if !ix.Visible(sim.Vec2{X: 0, Y: 0}, sim.Vec2{X: 8, Y: 0}) {
		t.Fatal("平行于墙侧面的视线不应被拦截")
	}
}
