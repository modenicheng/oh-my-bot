// Package snapshot 实现感知裁剪与快照编码（T3 独占包）。
//
// 职责（ADR-0004：服务器维护 Observation）：
//   - BuildObservation：以某机器人视角裁剪世界——默认视野 20m（中心距，脉冲
//     感知可传入 32m）+ 墙体线段遮挡 + Partner 豁免（恒在）+ Core/Uplink 恒全量；产物即 T2 脚本
//     的唯一合法感知输入。
//   - DeltaEncoder：把逐 tick 的 Observation 编成 ombv1.SnapshotDelta——
//     full 全量 / delta 只含变化实体 + tombstone，base_tick 供客户端缺口
//     检测，ResyncRequest 后可 ForceFull。
//
// sim 包只读（import 仅为契约类型，见 sim/contract.go 冻结说明）。
// 注意：sim.FrameView 本身不携带实体列表（契约如此，实体视图由 sim 内部
// 状态派生）；本包以 World 捆绑 FrameView 与实体视图，由调用方在 tick 边界
// 组装。墙体索引 NewWallIndex 显式预计算一次、全场复用，满足
// 64 观察者 × 64 目标 × ~40 墙 < 2ms/tick 的性能契约（见 bench_test.go）。
package snapshot

import (
	"math"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// defaultVisionRadius is the ordinary scan radius. A successful pulse scan is
// passed by the glue layer as 32m for exactly one observation frame.
const (
	defaultVisionRadius = 20.0
	// visionRadius remains the wall-index default for compatibility with the
	// fixed-size spatial grid; pulse observations still use a 32m query radius.
	visionRadius = defaultVisionRadius
)

// World 是一 tick 的完整世界视图：sim.FrameView + 全量实体视图。
// 由调用方（net 层在 tick 边界）从 sim 组装；本包不修改。
type World struct {
	sim.FrameView
	Robots      []sim.RobotView
	Projectiles []sim.ProjView
	Cores       []sim.CoreView
	HealthPacks []sim.HealthPackView
	Uplinks     []sim.UplinkView
	PointDrops  []sim.PointDropView
}

// WorldOf 把 sim 的冻结 WorldView 转为本包 World（逐字段拷贝，不共享底层
// 可变状态；切片本身只读，直传即可）。Controls/PulseScans/AckSeqs 属于
// glue 专用通道，不进入感知裁剪输入。
func WorldOf(wv sim.WorldView) World {
	return World{
		FrameView:   wv.Frame,
		Robots:      wv.Robots,
		Projectiles: wv.Projectiles,
		Cores:       wv.Cores,
		HealthPacks: wv.HealthPacks,
		Uplinks:     wv.Uplinks,
		PointDrops:  wv.PointDrops,
	}
}

// BuildObservation filters a frozen world from observerID's point of view.
// Robots and projectiles require range plus line of sight; the observer is always visible.
// Cores, health packs, and uplinks are public map objects. Uplink personal cooldowns
// are reduced to the observer to avoid leaking other players' cooldown state.
// The fourth parameter is retained for source compatibility and ignored.
func BuildObservation(w World, ix *WallIndex, observerID, _ uint32, radii ...float64) sim.Observation {
	visionRadius := defaultVisionRadius
	if len(radii) > 0 && radii[0] > 0 && !math.IsNaN(radii[0]) && !math.IsInf(radii[0], 0) {
		visionRadius = radii[0]
	}
	world := sim.WorldView{Frame: w.FrameView, Robots: w.Robots, Projectiles: w.Projectiles, Cores: w.Cores, HealthPacks: w.HealthPacks, Uplinks: w.Uplinks, PointDrops: w.PointDrops}
	var visibility func(sim.Vec2, sim.Vec2) bool
	if ix != nil && (w.Map == nil || w.Map.CoreZone.Radius == 0 || w.Phase >= w.Map.CoreZone.UnlockPhase) {
		visibility = ix.Visible
	}
	obs, found := world.ObserveLocal(observerID, visionRadius, visibility)
	if !found {
		return sim.Observation{Frame: sim.FrameView{Tick: w.Tick, Phase: w.Phase, TimeLeftS: w.TimeLeftS, Map: &sim.MapDef{Version: 1, Partial: true}}, VisionRadius: visionRadius}
	}
	return obs
}
