package mapgen

import (
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 骨架墙常量（米）。
const (
	ringWallHalfLen = 14.0 // 环墙段半长（28m 弦）
	ringWallThick   = 1.2  // 环墙厚
	spokeHalfLen    = 7.0  // 径向墙半长（14m）
	spokeThick      = 1.2  // 径向墙厚
	midRingWallR    = 47.5 // 中环环墙半径（Uplink 带 40–45 之外）
	spokeInnerR     = 34.0 // 径向墙内端半径
	spokeOuterR     = 48.0 // 径向墙外端半径
)

// 掩体常量（米）。
const (
	coverHalfLen  = 2.6 // 掩体半长（5.2m）
	coverThick    = 0.7 // 掩体厚
	poiClearance  = 2.2 // 墙到出生方块/刷新点的最小净空（> 机器人直径 1.2m）
	wallClearance = 1.5 // 墙到墙 / 墙到 Uplink 的最小净空
)

// 每 90° 象限的掩体尝试数（四面旋转同时落 4 块；被拒即丢弃，不重试）。
const (
	midCoverAttemptsPerQuad   = 12 // 中环密
	outerCoverAttemptsPerQuad = 5  // 外环疏
)

// skeletonWalls 构造八辐骨架墙（每象限 3 段、共 12 段，全部 AABB）：
//
//   - 中环环墙 ×2/象限：r=47.5m，角度 22.5° 与 67.5°（均错位扇区轴 22.5°，
//     即 Uplink 角度族）——为 Uplink 带提供结构掩体；
//   - 径向墙 ×1/象限：34–48m，角度 45°（扇区轴对角）——强化辐条意象，
//     制造中环走廊。
//
// 每段环墙长轴沿切向（垂直于所在半径方向），径向墙长轴沿径向主轴。集合绕
// 原点旋转 90° 严格不变。
func skeletonWalls() []sim.Wall {
	out := make([]sim.Wall, 0, 12)
	id := uint32(1)
	add := func(cx, cy, hx, hy float64) {
		out = append(out, sim.Wall{
			ID:  id,
			Min: sim.Vec2{X: cx - hx, Y: cy - hy},
			Max: sim.Vec2{X: cx + hx, Y: cy + hy},
		})
		id++
	}
	// 环墙：22.5°/67.5° + k·90°。长轴沿切向：方向以 X 为主 → 切向以 Y 为主。
	for _, step := range []int{3, 9} { // 7.5°·3=22.5°, 7.5°·9=67.5°
		for k := 0; k < 4; k++ {
			d := dirAt(step + 12*k)
			c := d.Scale(midRingWallR)
			if d.X*d.X > d.Y*d.Y {
				add(c.X, c.Y, ringWallThick/2, ringWallHalfLen)
			} else {
				add(c.X, c.Y, ringWallHalfLen, ringWallThick/2)
			}
		}
	}
	// 径向墙：45° + k·90°，34–48m。长轴沿径向主轴。
	for k := 0; k < 4; k++ {
		d := dirAt(6 + 12*k) // 7.5°·6 = 45°
		c := d.Scale((spokeInnerR + spokeOuterR) / 2)
		half := (spokeOuterR - spokeInnerR) / 2
		if d.X*d.X > d.Y*d.Y {
			add(c.X, c.Y, half, spokeThick/2)
		} else {
			add(c.X, c.Y, spokeThick/2, half)
		}
	}
	return out
}

// genWalls 生成全部墙体 = 骨架墙 + seed 驱动的掩体。掩体以 90° 象限采样、
// 四面旋转同时落 4 块（保证墙体集合绕原点旋转 90° 严格不变，从而对 8 个
// 45° 楔统计特征一致）。每块掩体须与出生方块/刷新点净空 ≥ 2.2m、与既有墙/
// Uplink 净空 ≥ 1.5m；每落一批（4 块）即做增量 BFS 连通性守卫，失败则整批
// 丢弃。最终全集连通性由 validateConnectivity 兜底断言。
func genWalls(r *rng, skeleton []sim.Wall, uplinks []sim.UplinkDef, pads []sim.CorePadDef) ([]sim.Wall, error) {
	walls := append([]sim.Wall{}, skeleton...)
	nextID := uint32(len(skeleton)) + 1

	spawns := spawnThreatRects()
	uplinkPts := make([]sim.Vec2, len(uplinks))
	for i, u := range uplinks {
		uplinkPts[i] = u.Pos
	}
	padPts := make([]sim.Vec2, len(pads))
	for i, p := range pads {
		padPts[i] = p.Pos
	}

	clear := func(q sim.Rect) bool {
		for _, s := range spawns {
			if g := rectGap2(q, s); g < 0 || g < poiClearance*poiClearance {
				return false
			}
		}
		for _, p := range padPts {
			if rectNearestDist2(q, p) < poiClearance*poiClearance {
				return false
			}
		}
		for _, p := range uplinkPts {
			if rectNearestDist2(q, p) < wallClearance*wallClearance {
				return false
			}
		}
		for _, w := range walls {
			if g := rectGap2(q, wallRect(w)); g < 0 || g < wallClearance*wallClearance {
				return false
			}
		}
		return true
	}

	// stamp：在第一象限采样一块掩体原型，四面旋转各放一块。
	covers := make([]sim.Wall, 0, 64)
	stamp := func(lo, hi float64) bool {
		for tries := 0; tries < 64; tries++ {
			x, y := r.rangeF(0, hi), r.rangeF(0, hi)
			if d2 := x*x + y*y; d2 < lo*lo || d2 > hi*hi {
				continue
			}
			// 长轴取该象限采样点的主轴（x≥y → X 长）；四面旋转后四种
			// 朝向恰好各出现一次，总体各向同性。
			hx, hy := coverHalfLen, coverThick/2
			if y > x {
				hx, hy = coverThick/2, coverHalfLen
			}
			quad := [4]sim.Rect{
				rectOf(x, y, hx, hy),
				rectOf(-y, x, hy, hx),
				rectOf(-x, -y, hx, hy),
				rectOf(y, -x, hy, hx),
			}
			for _, q := range quad {
				if !clear(q) {
					return false
				}
			}
			batch := make([]sim.Wall, 4)
			for i, q := range quad {
				batch[i] = sim.Wall{ID: nextID, Min: q.Min, Max: q.Max}
				nextID++
			}
			// 连通性守卫：整批加入后两种阶段模式都必须连通。
			if !connectivityOK(append(walls, batch...), uplinkPts, padPts) {
				return false
			}
			walls = append(walls, batch...)
			covers = append(covers, batch...)
			return true
		}
		return false
	}

	for i := 0; i < midCoverAttemptsPerQuad; i++ {
		stamp(33, 52) // 中环带（避开锁区 28.6 与 Uplink 带）
	}
	for i := 0; i < outerCoverAttemptsPerQuad; i++ {
		stamp(59, 74) // 外环带（避开出生方块净空由 clear 保证）
	}
	return walls, nil
}

// spawnThreatRects 返回 8 个出生方块（墙须与其保持净空）。
func spawnThreatRects() []sim.Rect {
	out := make([]sim.Rect, 8)
	for k := 0; k < 8; k++ {
		out[k] = spawnAreaOf(k)
	}
	return out
}
