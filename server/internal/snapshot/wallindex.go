package snapshot

import (
	"math"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// WallIndex 是墙体均匀网格索引：视线查询先取线段包围盒覆盖的格子，仅对
// 命中格内的墙做精确线段-AABB 测试（粗筛 + 精筛两级）。
//
// 预计算一次、只读共享、并发安全（无 mutation），一局内所有 tick、所有
// 观察者复用同一实例。
type WallIndex struct {
	// walls 扁平存储全部墙（ID+Min+Max），格子只存下标。
	walls []sim.Wall
	// cellSide 为格子边长（米）；cells[y][x] 为该格内的墙下标列表。
	cellSide   float64
	cells      [][]([]int32)
	minX, minY float64
	cols, rows int
}

// NewWallIndex 用 MapDef.Walls 建索引。cellSide 建议 20（视野半径）：
// 视线段长度上限即 20m，包围盒至多覆盖 ~2×3 格，粗筛命中的墙数远小于
// 全表扫描。cellSide ≤ 0 时取默认 20。
func NewWallIndex(walls []sim.Wall, cellSide float64) *WallIndex {
	if cellSide <= 0 {
		cellSide = visionRadius
	}
	ix := &WallIndex{walls: append([]sim.Wall(nil), walls...), cellSide: cellSide}
	if len(ix.walls) == 0 {
		return ix
	}
	var minX, minY, maxX, maxY float64
	first := ix.walls[0]
	minX, minY, maxX, maxY = first.Min.X, first.Min.Y, first.Max.X, first.Max.Y
	for _, w := range ix.walls[1:] {
		if w.Min.X < minX {
			minX = w.Min.X
		}
		if w.Min.Y < minY {
			minY = w.Min.Y
		}
		if w.Max.X > maxX {
			maxX = w.Max.X
		}
		if w.Max.Y > maxY {
			maxY = w.Max.Y
		}
	}
	ix.minX, ix.minY = minX, minY
	ix.cols = max(1, int(math.Ceil((maxX-minX)/cellSide)))
	ix.rows = max(1, int(math.Ceil((maxY-minY)/cellSide)))
	ix.cells = make([][]([]int32), ix.rows)
	// 墙 AABB 覆盖到的每个格子都登记（墙可跨格）。
	for wi, w := range ix.walls {
		x0 := ix.clampCol(ix.colOf(w.Min.X))
		x1 := ix.clampCol(ix.colOf(w.Max.X))
		y0 := ix.clampRow(ix.rowOf(w.Min.Y))
		y1 := ix.clampRow(ix.rowOf(w.Max.Y))
		for y := y0; y <= y1; y++ {
			if ix.cells[y] == nil {
				ix.cells[y] = make([]([]int32), ix.cols)
			}
			for x := x0; x <= x1; x++ {
				ix.cells[y][x] = append(ix.cells[y][x], int32(wi))
			}
		}
	}
	return ix
}

// Visible 判断 from→to 视线是否无遮挡。零墙直接可见；否则遍历视线包围盒
// 覆盖的格子，先做墙 AABB 与视线包围盒的重叠粗筛，再做精确线段-AABB
// 相交测试。同一墙可能登记在多个格子，但跨格重复测试只影响少量性能，
// 不影响正确性（遮挡判定幂等）；包围盒对齐下通常至多重复一次。
func (ix *WallIndex) Visible(from, to sim.Vec2) bool {
	if len(ix.walls) == 0 {
		return true
	}
	bx0, by0, bx1, by1 := from.X, from.Y, to.X, to.Y
	if bx0 > bx1 {
		bx0, bx1 = bx1, bx0
	}
	if by0 > by1 {
		by0, by1 = by1, by0
	}
	cx0 := ix.clampCol(ix.colOf(bx0))
	cx1 := ix.clampCol(ix.colOf(bx1))
	cy0 := ix.clampRow(ix.rowOf(by0))
	cy1 := ix.clampRow(ix.rowOf(by1))
	for y := cy0; y <= cy1; y++ {
		row := ix.cells[y]
		if row == nil {
			continue
		}
		for x := cx0; x <= cx1; x++ {
			for _, wi := range row[x] {
				w := &ix.walls[wi]
				// 粗筛：墙 AABB 与视线包围盒不相交则跳过精确测试。
				if w.Max.X < bx0 || w.Min.X > bx1 || w.Max.Y < by0 || w.Min.Y > by1 {
					continue
				}
				if segmentIntersectsAABB(from, to, w.Min, w.Max) {
					return false
				}
			}
		}
	}
	return true
}

// colOf/rowOf：坐标 → 格子序号（可为负/越界，由 clamp 收敛）。
func (ix *WallIndex) colOf(x float64) int { return int(math.Floor((x - ix.minX) / ix.cellSide)) }
func (ix *WallIndex) rowOf(y float64) int { return int(math.Floor((y - ix.minY) / ix.cellSide)) }

func (ix *WallIndex) clampCol(c int) int { return clamp(c, 0, ix.cols-1) }
func (ix *WallIndex) clampRow(r int) int { return clamp(r, 0, ix.rows-1) }

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// axisClip：slab 法单轴裁剪。返回 false 表示区间已空（不相交）。
func axisClip(p0, d, lo, hi float64, tmin, tmax *float64) bool {
	const eps = 1e-12
	if d > eps || d < -eps {
		inv := 1 / d
		t1 := (lo - p0) * inv
		t2 := (hi - p0) * inv
		if t1 > t2 {
			t1, t2 = t2, t1
		}
		if t1 > *tmin {
			*tmin = t1
		}
		if t2 < *tmax {
			*tmax = t2
		}
		return *tmin <= *tmax
	}
	// 退化轴：线段与该 slab 平行，起点分量须在 slab 内（含边界）。
	return p0 >= lo && p0 <= hi
}

// segmentIntersectsAABB：精确测试线段 p0→p1 是否与 AABB (min,max) 相交。
// slab 法 + 参数区间裁剪：t ∈ [tmin,tmax] ⊆ [0,1] 非空即相交。
func segmentIntersectsAABB(p0, p1, min, max sim.Vec2) bool {
	tmin, tmax := 0.0, 1.0
	if !axisClip(p0.X, p1.X-p0.X, min.X, max.X, &tmin, &tmax) {
		return false
	}
	if !axisClip(p0.Y, p1.Y-p0.Y, min.Y, max.Y, &tmin, &tmax) {
		return false
	}
	return true
}
