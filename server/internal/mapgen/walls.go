package mapgen

import (
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 骨架墙常量（米）。
const (
	spokeInnerR     = 34.0 // 径向墙内端半径
	spokeOuterR     = 48.0 // 径向墙外端半径
	spokeThick      = 1.2  // 径向墙厚
	ringWallR       = 49.0 // 环墙半径（中环带内、Uplink 带 40–45m 之外）
	ringWallHalfLen = 14.0 // 环墙段半长（28m 弦）
	ringWallThick   = 1.2  // 环墙厚
)

// 掩体常量（米）。
const (
	coverHalfLen  = 2.6 // 掩体半长（5.2m）
	coverThick    = 0.7 // 掩体厚
	poiClearance  = 2.2 // 墙到出生方块/刷新点的最小净空（> 机器人直径 1.2m）
	wallClearance = 2.2 // 墙到墙 / 墙到 Uplink 的最小净空（≥1.2+1.0 保证 BFS 格可通行）
)

// 掩体批数（每批 = 原型 × k·45° 旋转 = 8 块同形掩体，每 45° 楔恰得 1 块）。
const (
	midCoverBatches   = 8 // 中环密（≤64 块）
	outerCoverBatches = 4 // 外环疏（≤32 块）
)

// skeletonWalls 构造八辐骨架墙（16 段，全部 AABB）：
//
//   - 径向墙 ×8：34–48m，角度 k·45°（扇区轴），长轴沿径向——辐条意象；
//   - 环墙 ×8：49m，角度 k·45°+22.5°（Uplink 角度族），长轴沿切向——为
//     Uplink 带提供环形掩体结构；相邻环墙间留 11.8° 通道。
//
// 对称性：每个 45° 楔内恰有一段径向墙 + 一段环墙，尺寸逐楔相同（面积
// 16.8 / 33.6 m²，周长 30.4 / 57.6 m）；集合绕原点旋转 90° 严格不变
// （bit 级：径向墙对角位用 k%4 交替长轴，环墙切向长轴规则在 90° 旋转下
// 自洽，中心由 (x,y)→(−y,x) 精确映射）。
func skeletonWalls() []sim.Wall {
	out := make([]sim.Wall, 0, 16)
	id := uint32(1)
	// 径向墙：k*45°（step 6k），34–48m。长轴取 X 当且仅当 k%4<2——
	// 使 45°/135°/225°/315° 对角位在 90° 旋转下两两互映射（精确）。
	for k := 0; k < 8; k++ {
		d := dirAt(6 * k)
		c := d.Scale((spokeInnerR + spokeOuterR) / 2)
		half := (spokeOuterR - spokeInnerR) / 2
		var r rect
		if k%4 < 2 {
			r = rectAt(c, half, spokeThick/2)
		} else {
			r = rectAt(c, spokeThick/2, half)
		}
		out = append(out, rectToWall(id, r))
		id++
	}
	// 环墙：k*45°+22.5°（step 6k+3），49m，长轴沿切向（切向 X 分量大 → X 长）。
	for k := 0; k < 8; k++ {
		d := dirAt(6*k + 3)
		c := d.Scale(ringWallR)
		var r rect
		if d.Y*d.Y > d.X*d.X { // 方向 Y 为主 → 切向 X 为主
			r = rectAt(c, ringWallHalfLen, ringWallThick/2)
		} else {
			r = rectAt(c, ringWallThick/2, ringWallHalfLen)
		}
		out = append(out, rectToWall(id, r))
		id++
	}
	return out
}

// rectToWall 以指定 ID 将 rect 转为 sim.Wall。
func rectToWall(id uint32, r rect) sim.Wall {
	return sim.Wall{
		ID:  id,
		Min: sim.Vec2{X: r.MinX, Y: r.MinY},
		Max: sim.Vec2{X: r.MaxX, Y: r.MaxY},
	}
}

// rot90Rect 将 AABB 绕原点旋转 90°（精确算术：角点 (x,y)→(−y,x) + min/max）。
func rot90Rect(r rect) rect {
	a := rot90(sim.Vec2{X: r.MinX, Y: r.MinY})
	b := rot90(sim.Vec2{X: r.MaxX, Y: r.MaxY})
	return rect{
		MinX: min(a.X, b.X), MinY: min(a.Y, b.Y),
		MaxX: max(a.X, b.X), MaxY: max(a.Y, b.Y),
	}
}

// wedgeCenter 返回原型点 p 旋转 k·45° 后的位置：奇数 k 先做一次 45° 旋转
// （IEEE754 乘加，确定性），再统一走 n=k>>1 次精确 90° 旋转。该构造使
// "集合绕原点旋转 90°" 在 bit 级成立（wedge k 与 wedge k+2 的中心与形状
// 由完全相同的浮点运算链产生）。
func wedgeCenter(p sim.Vec2, k int) sim.Vec2 {
	q := p
	if k%2 == 1 {
		q = rot45(q)
	}
	for i := 0; i < (k>>1)%4; i++ {
		q = rot90(q)
	}
	return q
}

// coverXLong 掩体长轴取向：k%4∈{0,3} 取 X。与 wedgeCenter 的旋转链配合，
// 任意掩体绕原点旋转 90° 后与楔 k+2 的掩体完全一致（精确）。
func coverXLong(k int) bool { return k%4 == 0 || k%4 == 3 }

// genWalls 生成全部墙体 = 骨架墙 + seed 驱动的掩体。
//
// 掩体盖章：原型中心采样于楔 0 内部（0.8°≤θ≤42°，留边界余量），每批沿
// k·45°（k=0..7）盖 8 块同形掩体（5.2×0.7m，仅长轴取向两种）——每个
// 45° 楔恰得 1 块，逐楔掩体数/面积/周长严格相等；整批通过净空检查
// （出生方块与刷新点 ≥2.2m、既有墙与 Uplink ≥2.2m）与双模式 BFS 连通
// 守卫才接受，否则换样重采（批内至多 96 次），全部失败则跳过该批
// （对称性不受影响）。密度规则：中环密（8 批，r∈[34,51]）、外环疏
// （4 批，r∈[59,74]）。
func genWalls(r *rng, skeleton []sim.Wall, uplinks []sim.UplinkDef, pads []sim.CorePadDef) ([]sim.Wall, error) {
	walls := append([]sim.Wall{}, skeleton...)
	nextID := uint32(len(skeleton)) + 1

	spawns := make([]rect, 8)
	for k := range spawns {
		spawns[k] = spawnAreaOf(k)
	}
	padPts := make([]sim.Vec2, len(pads))
	for i, p := range pads {
		padPts[i] = p.Pos
	}

	// clear 判定一块掩体矩形是否满足全部净空约束。
	clear := func(q rect) bool {
		for _, s := range spawns {
			if g := gap2(q, s); g < 0 || g < poiClearance*poiClearance {
				return false
			}
		}
		for _, p := range padPts {
			if nearestDist2(q, p) < poiClearance*poiClearance {
				return false
			}
		}
		for _, u := range uplinks {
			if nearestDist2(q, u.Pos) < wallClearance*wallClearance {
				return false
			}
		}
		for _, w := range walls {
			if g := gap2(q, wallRect(w)); g < 0 || g < wallClearance*wallClearance {
				return false
			}
		}
		return true
	}

	// stampBatch：在楔 0 内拒绝采样原型（1≤y<0.9x 保证内部 + 边界余量，
	// 环带 [lo,hi] 过滤），盖 8 块同形掩体。成功返回 true。
	stampBatch := func(lo, hi float64) bool {
		for tries := 0; tries < 96; tries++ {
			x := r.rangeF(lo, hi)
			y := r.rangeF(1.0, 0.9*x)
			if y > x {
				continue
			}
			if d2 := x*x + y*y; d2 < lo*lo || d2 > hi*hi {
				continue
			}
			proto := sim.Vec2{X: x, Y: y}
			batch := make([]sim.Wall, 0, 8)
			for k := 0; k < 8; k++ {
				var hx, hy float64
				if coverXLong(k) {
					hx, hy = coverHalfLen, coverThick/2
				} else {
					hx, hy = coverThick/2, coverHalfLen
				}
				batch = append(batch, rectToWall(nextID, rectAt(wedgeCenter(proto, k), hx, hy)))
				nextID++
			}
			allClear := true
			for _, w := range batch {
				if !clear(wallRect(w)) {
					allClear = false
					break
				}
			}
			if !allClear || !connectivityOK(append(walls, batch...)) {
				nextID -= 8 // 编号回卷，保证 ID 连续（canonical）。
				continue
			}
			walls = append(walls, batch...)
			return true
		}
		return false
	}

	for i := 0; i < midCoverBatches; i++ {
		stampBatch(34, 51) // 中环带（锁区边界 28.6m 之外）
	}
	for i := 0; i < outerCoverBatches; i++ {
		stampBatch(59, 74) // 外环带（出生方块净空由 clear 保证）
	}
	if !connectivityOK(walls) {
		return nil, fmt.Errorf("final connectivity check failed")
	}
	return walls, nil
}
