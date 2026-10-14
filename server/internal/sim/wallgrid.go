package sim

import "sort"

// wallGrid 是墙体的均匀网格空间索引（批 2 压测结论：sweepContact 的全墙
// 遍历占 76% CPU——200 机器人 × 112 墙 × 60Hz 的 hypot 热路径）。
//
// 语义契约：wallsNear 返回的候选集覆盖「查询线段 + margin 的 AABB 相交的
// 全部墙」，且按墙 ID 升序——与全墙遍历（s.walls 恒按 ID 排序）在
// sweepContact/traceSolid 的 `t <= fraction` 逐步覆盖式 tie-breaking 下
// 产生逐位相同的结果。这是旧录像权威重放的前提，由
// TestWallGridMatchesFullScan 钉死。
//
// 构建于 SetWalls/SetMap/RestoreCheckpoint（walls 只读不变），运行期零
// 变更、无锁（sim 单 owner）。
type wallGrid struct {
	cell  float64
	minX  float64
	minY  float64
	cols  int
	rows  int
	cells [][]Wall
}

// wallGridCell 网格边长：覆盖典型掩体尺度（4–6m）与机器人半径，查询 AABB
// 通常只落 1–4 格。过小会让每墙注册格数膨胀，过大退化为全扫描。
const wallGridCell = 8.0

func buildWallGrid(walls []Wall, bound float64) *wallGrid {
	loX, loY, hiX, hiY := -bound, -bound, bound, bound
	for _, w := range walls {
		loX, loY = min(loX, w.Min.X), min(loY, w.Min.Y)
		hiX, hiY = max(hiX, w.Max.X), max(hiY, w.Max.Y)
	}
	g := &wallGrid{
		cell: wallGridCell,
		minX: loX, minY: loY,
		cols: int((hiX-loX)/wallGridCell) + 1,
		rows: int((hiY-loY)/wallGridCell) + 1,
	}
	g.cells = make([][]Wall, g.cols*g.rows)
	for _, w := range walls {
		x0 := g.col(w.Min.X)
		x1 := g.col(w.Max.X)
		y0 := g.row(w.Min.Y)
		y1 := g.row(w.Max.Y)
		for cy := y0; cy <= y1; cy++ {
			for cx := x0; cx <= x1; cx++ {
				g.cells[cy*g.cols+cx] = append(g.cells[cy*g.cols+cx], w)
			}
		}
	}
	for i := range g.cells {
		ws := g.cells[i]
		sort.Slice(ws, func(a, b int) bool { return ws[a].ID < ws[b].ID })
	}
	return g
}

func (g *wallGrid) col(x float64) int { return int((x - g.minX) / g.cell) }
func (g *wallGrid) row(y float64) int { return int((y - g.minY) / g.cell) }

// wallsNear 收集与「a→b 线段外扩 margin 的 AABB」相交的格内墙，合并去重
// 后按 ID 升序写入复用缓冲（sim 单 owner，无并发）。缓冲在下一次调用前
// 有效——调用方不得跨调用持有切片。
func (g *wallGrid) wallsNear(a, b Vec2, margin float64, buf []Wall) []Wall {
	out := buf[:0]
	loX, hiX := min(a.X, b.X)-margin, max(a.X, b.X)+margin
	loY, hiY := min(a.Y, b.Y)-margin, max(a.Y, b.Y)+margin
	x0, x1 := g.col(loX), g.col(hiX)
	y0, y1 := g.row(loY), g.row(hiY)
	if x1 < 0 || y1 < 0 || x0 >= g.cols || y0 >= g.rows {
		return out
	}
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, g.cols-1), min(y1, g.rows-1)
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			out = append(out, g.cells[cy*g.cols+cx]...)
		}
	}
	// 一墙可跨多格：按 ID 去重（格内已升序，同 ID 相邻）。
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	out = uniqueByID(out)
	return out
}

func uniqueByID(ws []Wall) []Wall {
	if len(ws) < 2 {
		return ws
	}
	out := ws[:1]
	for _, w := range ws[1:] {
		if w.ID != out[len(out)-1].ID {
			out = append(out, w)
		}
	}
	return out
}

// rebuildWallIndex 在 walls 被整体替换后重建空间索引（SetWalls / SetMap /
// RestoreCheckpoint 三个装配入口）。空墙集（无图对局）索引为 nil，查询
// 回退全遍历。
func (s *Sim) rebuildWallIndex() {
	if len(s.walls) == 0 {
		s.wallIX = nil
		s.wallBuf = nil
		return
	}
	bound := legacyArenaDiskR
	if r := arenaDiskRadiusOf(s.mapDef); r > bound {
		bound = r
	}
	s.wallIX = buildWallGrid(s.walls, bound)
	s.wallBuf = make([]Wall, 0, 16)
}

// sweepWalls 返回当前查询的候选墙（按 ID 升序）。索引缺失时回退全墙
// （walls 本身按 ID 有序，语义一致）。
func (s *Sim) sweepWalls(a, b Vec2, margin float64) []Wall {
	if s.wallIX == nil {
		return s.walls
	}
	s.wallBuf = s.wallIX.wallsNear(a, b, margin, s.wallBuf)
	return s.wallBuf
}
