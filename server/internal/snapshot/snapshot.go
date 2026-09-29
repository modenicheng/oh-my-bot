// Package snapshot 实现感知裁剪与快照编码（T3 独占包）。
//
// 职责（ADR-0004：服务器维护 Observation）：
//   - BuildObservation：以某机器人视角裁剪世界——视野 20m（中心距）+ 墙体
//     线段遮挡 + Partner 豁免（恒在）+ Core/Uplink 恒全量；产物即 T2 脚本
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

import "github.com/modenicheng/oh-my-bot/server/internal/sim"

// visionRadius 视野半径（米），设计 §5：中心距 20m（gameplay 同名常量的
// 只读镜像——不 import sim 内部实现，避免 T1 WIP 依赖）。
const visionRadius = 20.0

const visionRadiusSq = visionRadius * visionRadius

// World 是一 tick 的完整世界视图：sim.FrameView + 全量实体视图。
// 由调用方（net 层在 tick 边界）从 sim 组装；本包不修改。
type World struct {
	sim.FrameView
	Robots      []sim.RobotView
	Projectiles []sim.ProjView
	Cores       []sim.CoreView
	Uplinks     []sim.UplinkView
}

// BuildObservation 以 observerID 视角裁剪 w，产出契约定义的 Observation：
//
//   - Robots：观察者自身恒在（不受裁剪）；partnerID 恒在（豁免距离与遮挡，
//     PartnerID 标记）；其余按 中心距 ≤ 20m 且视线不被任何墙拦截 裁剪。
//   - Projectiles：同视野规则（无豁免）。
//   - Cores / Uplinks：恒全量（地图对象）。
//   - Uplinks.PersonalCDs 收敛为仅观察者自身条目（契约注释：观察者按需取
//     自身；顺带避免把他人 CD 泄露给脚本）。
//
// ix 为 nil 时视作无墙（全部可见）。观察者不存在于 w.Robots 时，视野中心
// 退化为 (0,0)（v1 无观战者，属调用方错误，不 panic）。
func BuildObservation(w World, ix *WallIndex, observerID, partnerID uint32) sim.Observation {
	obs := sim.Observation{
		Frame:     w.FrameView,
		PartnerID: partnerID,
		Cores:     append([]sim.CoreView(nil), w.Cores...),
	}

	// Uplink 恒全量，PersonalCDs 收敛到观察者。
	for _, u := range w.Uplinks {
		cu := u
		cu.PersonalCDs = nil
		if cd, ok := u.PersonalCDs[observerID]; ok {
			cu.PersonalCDs = map[uint32]uint32{observerID: cd}
		}
		obs.Uplinks = append(obs.Uplinks, cu)
	}

	// 观察者位置（自身视图不受裁剪，先定位）。
	var center sim.Vec2
	for i := range w.Robots {
		if w.Robots[i].ID == observerID {
			r := w.Robots[i]
			center = r.Pos
			obs.Robots = append(obs.Robots, r) // 自身恒可见
			break
		}
	}

	for i := range w.Robots {
		r := &w.Robots[i]
		if r.ID == observerID {
			continue
		}
		if partnerID != 0 && r.ID == partnerID {
			obs.Robots = append(obs.Robots, *r) // Partner 豁免：距离与遮挡都不设限
			continue
		}
		if !inVision(center, r.Pos, ix) {
			continue
		}
		obs.Robots = append(obs.Robots, *r)
	}

	for i := range w.Projectiles {
		p := &w.Projectiles[i]
		if inVision(center, p.Pos, ix) {
			obs.Projectiles = append(obs.Projectiles, *p)
		}
	}
	return obs
}

// inVision：中心距 ≤ 20m 且视线未被墙拦截（先廉价距离筛，再遮挡精确测试）。
func inVision(from, to sim.Vec2, ix *WallIndex) bool {
	dx, dy := to.X-from.X, to.Y-from.Y
	if dx*dx+dy*dy > visionRadiusSq {
		return false
	}
	if ix == nil {
		return true
	}
	return ix.Visible(from, to)
}
