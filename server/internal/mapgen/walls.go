package mapgen

import (
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

const (
	coverThick      = 0.7
	poiClearance    = 2.5
	wallClearance   = 2.2
	innerCoverCells = 1
	midCoverCells   = 4
	outerCoverCells = 2
)

type coverCell struct {
	radius, angle      float64
	halfLen, halfThick float64
	// lShape 标记两件套 L 层：每楔盖出「4×0.7 基座 + 2×0.7 垂直短杠」
	// 组成的连通 L 形剪影（两件按设计正面积相交约 0.7×0.7），而非单块 AABB。
	lShape bool
}

// lPiece 为 L 装配组件在规范定向框（偶楔 k≡0 / 奇楔 k≡1）下的定义。
type lPiece struct {
	offX, offY float64 // 相对装配中心的偏移
	hx, hy     float64 // 半边
}

// L 形掩体几何：4×0.7 基座横杠 + 与之垂直的 2×0.7 短杠。短杠中心偏移
// (lStubOffX, lStubOffY)：沿基座长轴落在末段（基座半长 2.0，短杠半厚
// 0.35 ⇒ 交叠宽 2.0−(1.65−0.35)=0.7），横向跨过基座中线（交叠高
// 0.35−(0.65−1.0)=0.7）。两矩形正面积相交 0.7×0.7、并集连通——是真实
// 的 L 剪影，而非仅相接甚至分离的两块。
const (
	lStubOffX = 1.65
	lStubOffY = 0.65
	lStubHalf = 1.0 // 短杠长轴半边（2×0.7）
)

func rectToWall(id uint32, r rect) sim.Wall {
	return sim.Wall{ID: id, Min: sim.Vec2{X: r.MinX, Y: r.MinY}, Max: sim.Vec2{X: r.MaxX, Y: r.MaxY}}
}

// Exact quarter turns keep the AABB multiset invariant under 90° rotation.
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

func coverXLong(k int) bool { return k%4 == 0 || k%4 == 3 }

// lProto 返回规范定向框的原型（family = k mod 2）。偶楔（k=0）基座 X 长、
// 短杠 Y 长；奇楔（k=1）从偶框整体旋转 90° 起步（rot90(1.65,0.65)=
// (−0.65,1.65)，半边同步转置），使基座定向与 coverXLong 约定一致
// （k0/3/4/7 横向，其余纵向）。
func lProto(family int) [2]lPiece {
	if family == 0 {
		return [2]lPiece{
			{offX: 0, offY: 0, hx: 2.0, hy: coverThick / 2},
			{offX: lStubOffX, offY: lStubOffY, hx: coverThick / 2, hy: lStubHalf},
		}
	}
	return [2]lPiece{
		{offX: 0, offY: 0, hx: coverThick / 2, hy: 2.0},
		{offX: -lStubOffY, offY: lStubOffX, hx: lStubHalf, hy: coverThick / 2},
	}
}

// stampedPiece 为盖到某楔后的单块矩形；group >= 0 表示它属于该编号的
// L 装配。同装配两件按设计正面积相交，豁免相互的 2.2m 间距约束。
type stampedPiece struct {
	r     rect
	group int
}

// stampCell 把单元格原型盖到楔 k。普通层每楔 1 件（coverXLong 定向）；
// L 层每楔 2 件：偶/奇定向框各自把偏移与半边做 t=(k>>1)%4 次同步四分
// 之一旋转（(x,y)→(−y,x)，半边交换），于是任意楔 k+2 的装配恰为楔 k
// 装配的精确 90° 旋转像（90° 墙集多重集严格不变的根基）；45° 方向由
// wedgeCenter 的 rot45 保证逐楔统计对称（AABB 旋转 45° 后不再是 AABB，
// 两定向框的短杠角度残差按构造不同，故对称断言用楔统计而非逐类残差）。
func stampCell(c coverCell, proto sim.Vec2, k int) []stampedPiece {
	if !c.lShape {
		hx, hy := c.halfLen, c.halfThick
		if !coverXLong(k) {
			hx, hy = hy, hx
		}
		return []stampedPiece{{r: rectAt(wedgeCenter(proto, k), hx, hy), group: -1}}
	}
	fam := lProto(k % 2)
	out := make([]stampedPiece, 0, 2)
	t := (k >> 1) % 4
	for _, p := range fam {
		ox, oy, hx, hy := p.offX, p.offY, p.hx, p.hy
		for q := 0; q < t; q++ {
			ox, oy, hx, hy = -oy, ox, hy, hx
		}
		out = append(out, stampedPiece{
			r:     rectAt(wedgeCenter(proto, k).Add(sim.Vec2{X: ox, Y: oy}), hx, hy),
			group: k,
		})
	}
	return out
}

func pieceHasClearance(piece stampedPiece, batch []stampedPiece) bool {
	for _, other := range batch {
		if piece.group >= 0 && other.group == piece.group {
			continue
		}
		if gap2(piece.r, other.r) < wallClearance*wallClearance {
			return false
		}
	}
	return true
}

// positiveOverlap 判断两矩形是否正面积相交（交叠宽高均 > 0，贴边不算）。
func positiveOverlap(a, b rect) bool {
	w, h := overlapDims(a, b)
	return w > 0 && h > 0
}

// overlapDims 返回两矩形的交叠宽高（不相交或贴边时 ≤ 0）。
func overlapDims(a, b rect) (float64, float64) {
	return min(a.MaxX, b.MaxX) - max(a.MinX, b.MinX), min(a.MaxY, b.MaxY) - max(a.MinY, b.MinY)
}

// genWalls lays out deterministic grid-sized cover cells. Six single-piece
// strata stamp one AABB per wedge; two offset mid-ring strata stamp genuine
// two-piece L silhouettes per wedge (4×0.7 base plus a perpendicular 2×0.7
// stub crossing near the end with a positive 0.7×0.7 overlap). The paired
// L layers make cover denser and less visually regular without sacrificing
// the eight-wedge fairness contract. sim.Wall stays a plain AABB: non-rectangular
// silhouettes emerge solely from overlapping AABB unions. The intentional
// overlap is confined to the two pieces of one assembly; every other pair of
// walls keeps the ≥2.2m separation.
//
// Candidates are a seeded cyclic traversal of a bounded 7×7 local lattice,
// with small shared radial/angular jitter. Rejection only relocates cover
// inside its assigned cell, never into an already crowded part of the ring.
func genWalls(r *rng, uplinks []sim.UplinkDef, pads []sim.CorePadDef, healthPacks []sim.HealthPackDef) ([]sim.Wall, error) {
	walls := make([]sim.Wall, 0, 8*(innerCoverCells+midCoverCells+outerCoverCells)*2)
	// Every cell is snapped to a 7.5-degree direction slot and a half-meter
	// radial lattice. The lShape stratum additionally stamps a perpendicular
	// stub over the base bar so the union forms an L-shaped cover.
	cells := []coverCell{
		{radius: 20, angle: 0, halfLen: 1.0, halfThick: coverThick / 2}, // inner ring: short cover inside the unlocked core
		{radius: 36, angle: 8, halfLen: 2.0, halfThick: coverThick / 2},
		{radius: 36, angle: 37, halfLen: 2.0, halfThick: coverThick / 2, lShape: true}, // inner-mid L stratum
		{radius: 49, angle: 8, halfLen: 2.0, halfThick: coverThick / 2, lShape: true},  // outer-mid L stratum
		{radius: 49, angle: 37, halfLen: 2.0, halfThick: coverThick / 2},
		{radius: 60, angle: 22.5, halfLen: 2.0, halfThick: coverThick / 2},
		{radius: 75, angle: 22.5, halfLen: 2.0, halfThick: coverThick / 2},
	}
	clear := func(q rect, allowCore bool) int {
		for _, p := range []sim.Vec2{{X: q.MinX, Y: q.MinY}, {X: q.MinX, Y: q.MaxY}, {X: q.MaxX, Y: q.MinY}, {X: q.MaxX, Y: q.MaxY}} {
			if p.Len() > outerMaxR-agentR {
				return 1
			}
		}
		if !allowCore && nearestDist2(q, sim.Vec2{}) < (coreZoneR+wallClearance)*(coreZoneR+wallClearance) {
			return 2
		}
		for k := 0; k < 8; k++ {
			if gap2(q, spawnAreaOf(k)) < poiClearance*poiClearance {
				return 3
			}
		}
		for _, p := range pads {
			if nearestDist2(q, p.Pos) < poiClearance*poiClearance {
				return 4
			}
		}
		for _, h := range healthPacks {
			if nearestDist2(q, h.Pos) < poiClearance*poiClearance {
				return 5
			}
		}
		for _, u := range uplinks {
			if nearestDist2(q, u.Pos) < wallClearance*wallClearance {
				return 5
			}
		}
		for _, w := range walls {
			if gap2(q, wallRect(w)) < wallClearance*wallClearance {
				return 6
			}
		}
		return 0
	}
	for cell, c := range cells {
		start := r.intn(49)
		radialJitter, angularJitter := r.rangeF(-0.25, 0.25), r.rangeF(-0.25, 0.25)
		accepted := false
		clearReject, batchReject, shapeReject, connectivityReject := 0, 0, 0, 0
		for attempt := 0; attempt < 49; attempt++ {
			index := (start + attempt) % 49
			var radius, angle float64
			if cell == 0 {
				// The inner stratum is inside the lock while closed and becomes
				// useful cover when CORE_OPEN. Search a deterministic 1m grid.
				radius = 19 + float64(index/7)*0.5 + radialJitter
				angle = float64(index%7)*7.5 + angularJitter
			} else {
				radius = c.radius + float64(index/7-3)*0.8 + radialJitter
				angle = c.angle + float64(index%7-3)*1.2 + angularJitter
			}
			proto := slotDirection(angle / 7.5).Scale(radius)
			batch := make([]sim.Wall, 0, 16)
			pieces := make([]stampedPiece, 0, 16)
			valid := true
			for k := 0; k < 8 && valid; k++ {
				for _, pc := range stampCell(c, proto, k) {
					if clear(pc.r, cell == 0) != 0 {
						clearReject++
						valid = false
						break
					}
					sibling := pc.group >= 0 && len(pieces) > 0 && pieces[len(pieces)-1].group == pc.group
					if sibling && !positiveOverlap(pieces[len(pieces)-1].r, pc.r) {
						shapeReject++
						valid = false
						break
					}
					if !pieceHasClearance(pc, pieces) {
						batchReject++
						valid = false
						break
					}
					pieces = append(pieces, pc)
					batch = append(batch, rectToWall(uint32(len(walls)+len(batch)+1), pc.r))
				}
			}
			if valid && connectivityOK(append(walls, batch...)) {
				walls = append(walls, batch...)
				accepted = true
				break
			}
			if valid {
				connectivityReject++
			}
		}
		if !accepted {
			return nil, fmt.Errorf("no legal cover in stratum %d (clear=%d batch=%d shape=%d connectivity=%d)",
				cell, clearReject, batchReject, shapeReject, connectivityReject)
		}
	}
	return walls, nil
}
