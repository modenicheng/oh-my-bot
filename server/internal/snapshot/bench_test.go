package snapshot

import (
	"math/rand"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- 合成场景：64 机器人 + 64 弹丸 + 40 墙，地图 80×80m ----

const (
	benchRobots  = 64
	benchWalls   = 40
	benchMapSize = 80.0
)

func benchWalls(r *rand.Rand) []sim.Wall {
	walls := make([]sim.Wall, 0, benchWallCount)
	for i := 0; i < benchWallCount; i++ {
		// 随机 2–6m 墙段，散布全图。
		x := r.Float64() * (benchMapSize - 8)
		y := r.Float64() * (benchMapSize - 8)
		walls = append(walls, sim.Wall{
			ID:  uint32(i + 1),
			Min: sim.Vec2{X: x, Y: y},
			Max: sim.Vec2{X: x + 2 + r.Float64()*4, Y: y + 0.6},
		})
	}
	return walls
}

func benchWorld(r *rand.Rand, tick uint32) World {
	robots := make([]sim.RobotView, benchRobots)
	for i := range robots {
		robots[i] = sim.RobotView{
			ID: uint32(i + 1), Pos: sim.Vec2{X: r.Float64() * benchMapSize, Y: r.Float64() * benchMapSize},
			HpX10: 1000, EnergyX10: 600, Nick: "bench", Color: "#fff",
		}
	}
	projs := make([]sim.ProjView, benchRobots)
	for i := range projs {
		projs[i] = sim.ProjView{ID: uint32(1000 + i), Owner: 1, Pos: sim.Vec2{X: r.Float64() * benchMapSize, Y: r.Float64() * benchMapSize}}
	}
	cores := make([]sim.CoreView, 8)
	for i := range cores {
		cores[i] = sim.CoreView{ID: uint32(2000 + i), Pos: sim.Vec2{X: r.Float64() * benchMapSize, Y: r.Float64() * benchMapSize}, Value: 10, Alive: true}
	}
	m := &sim.MapDef{Walls: benchWalls(r)}
	return World{
		FrameView:   sim.FrameView{Tick: tick, Phase: sim.PhaseOuterRing, TimeLeftS: 480, Map: m},
		Robots:      robots,
		Projectiles: projs,
		Cores:       cores,
	}
}

// BenchmarkVisibility：64 观察者 × (64 目标+64 弹丸) × 40 墙 的 BuildObservation 全流程。
// 性能契约：< 2ms / tick（60Hz 帧预算 12ms 内的感知预算）。
func BenchmarkVisibility(b *testing.B) {
	r := rand.New(rand.NewSource(42))
	walls := benchWalls(r)
	ix := NewWallIndex(walls, 0)
	w := benchWorld(r, 1)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for obs := 1; obs <= benchRobots; obs++ {
			BuildObservation(w, ix, uint32(obs), partnerOf(uint32(obs)))
		}
	}
}

// BenchmarkVisibilityNoIndex：对照——同样负载但逐墙全表扫描（证明索引收益）。
func BenchmarkVisibilityNoIndex(b *testing.B) {
	r := rand.New(rand.NewSource(40))
	walls := benchWalls(r)
	ix := NewWallIndex(walls, 0)
	w := benchWorld(r, 1)

	// 用 cellSide 极小的退化索引模拟全表扫描（每查询遍历全部 40 墙）。
	degenerate := &WallIndex{walls: walls, cellSide: 1e9, minX: 0, minY: 0, cols: 1, rows: 1,
		cells: [][]([]int32){{append([]int32(nil), seqInts(len(walls))...)}}}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for obs := 1; obs <= benchRobots; obs++ {
			BuildObservation(w, degenerate, uint32(obs), partnerOf(uint32(obs)))
		}
	}
}

func seqInts(n int) []int32 {
	out := make([]int32, n)
	for i := range out {
		out[i] = int32(i)
	}
	return out
}

func partnerOf(id uint32) uint32 {
	if id%2 == 0 {
		return id - 1
	}
	return id + 1
}

// BenchmarkSegmentAABB：单视线×单墙精确测试微基准。
func BenchmarkSegmentAABB(b *testing.B) {
	p0, p1 := sim.Vec2{X: 0, Y: 0}, sim.Vec2{X: 18, Y: 3}
	wall := sim.Wall{ID: 1, Min: sim.Vec2{X: 5, Y: -1}, Max: sim.Vec2{X: 6, Y: 8}}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		segmentIntersectsAABB(p0, p1, wall.Min, wall.Max)
	}
}

// BenchmarkEncode：单编码器逐 tick 编码（含变化检测）。
func BenchmarkEncode(b *testing.B) {
	r := rand.New(rand.NewSource(7))
	walls := benchWalls(r)
	ix := NewWallIndex(walls, 0)
	w := benchWorld(r, 1)
	enc := NewEncoder()
	obs := BuildObservation(w, ix, 1, 2)
	self := &SelfInput{Robot: w.Robots[0], MoveSrc: 'H'}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		enc.Encode(uint32(i), uint32(i), sim.PhaseCoreOpen, 240, obs, self)
	}
}
