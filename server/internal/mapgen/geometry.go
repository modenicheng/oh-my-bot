package mapgen

import (
	"math"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// dirCount 为方向表分辨率：48 步 × 7.5° = 360°。扇区轴（k*45° = 6k 步）与
// Uplink 错位角（k*45°+22.5° = 6k+3 步）都是表上精确点——生成路径零三角
// 函数调用（浮点基本运算 + 字面量表），保证跨平台 bit 级确定性。
const dirCount = 48

// dirTable 为 7.5° 步进的单位向量字面量表（6 位小数）。TestDirTable 校验
// 单位长度与相邻夹角（dot = cos7.5°），防止手抄笔误进入产出。
var dirTable = [dirCount]struct{ x, y float64 }{
	{1.000000, 0.000000}, {0.991445, 0.130526}, {0.965926, 0.258819}, {0.923880, 0.382683},
	{0.866025, 0.500000}, {0.793353, 0.608761}, {0.707107, 0.707107}, {0.608761, 0.793353},
	{0.500000, 0.866025}, {0.382683, 0.923880}, {0.258819, 0.965926}, {0.130526, 0.991445},
	{0.000000, 1.000000}, {-0.130526, 0.991445}, {-0.258819, 0.965926}, {-0.382683, 0.923880},
	{-0.500000, 0.866025}, {-0.608761, 0.793353}, {-0.707107, 0.707107}, {-0.793353, 0.608761},
	{-0.866025, 0.500000}, {-0.923880, 0.382683}, {-0.965926, 0.258819}, {-0.991445, 0.130526},
	{-1.000000, 0.000000}, {-0.991445, -0.130526}, {-0.965926, -0.258819}, {-0.923880, -0.382683},
	{-0.866025, -0.500000}, {-0.793353, -0.608761}, {-0.707107, -0.707107}, {-0.608761, -0.793353},
	{-0.500000, -0.866025}, {-0.382683, -0.923880}, {-0.258819, -0.965926}, {-0.130526, -0.991445},
	{0.000000, -1.000000}, {0.130526, -0.991445}, {0.258819, -0.965926}, {0.382683, -0.923880},
	{0.500000, -0.866025}, {0.608761, -0.793353}, {0.707107, -0.707107}, {0.793353, -0.608761},
	{0.866025, -0.500000}, {0.923880, -0.382683}, {0.965926, -0.258819}, {0.991445, -0.130526},
}

// dirAt 返回方向表第 step 步（7.5°·step）的单位向量；step 可为任意整数。
func dirAt(step int) sim.Vec2 {
	d := dirTable[((step%dirCount)+dirCount)%dirCount]
	return sim.Vec2{X: d.x, Y: d.y}
}

// rectOf 构造中心 (cx,cy)、半边 (hx,hy) 的轴对齐矩形。
func rectOf(cx, cy, hx, hy float64) sim.Rect {
	return sim.Rect{
		Min: sim.Vec2{X: cx - hx, Y: cy - hy},
		Max: sim.Vec2{X: cx + hx, Y: cy + hy},
	}
}

// wallRect 将 Wall 转为同构 Rect。
func wallRect(w sim.Wall) sim.Rect {
	return sim.Rect{Min: w.Min, Max: w.Max}
}

// rectNearestDist2 点到 AABB 的最近距离平方（点在矩形内为 0）。
// 只用乘加运算，避免 Hypot/Sqrt 的平台差异。
func rectNearestDist2(r sim.Rect, p sim.Vec2) float64 {
	dx := math.Max(r.Min.X-p.X, p.X-r.Max.X)
	dy := math.Max(r.Min.Y-p.Y, p.Y-r.Max.Y)
	if dx < 0 {
		dx = 0
	}
	if dy < 0 {
		dy = 0
	}
	return dx*dx + dy*dy
}

// rectFarthestDist2 点到 AABB 最远角的距离平方。
func rectFarthestDist2(r sim.Rect, p sim.Vec2) float64 {
	dx := math.Max(p.X-r.Min.X, r.Max.X-p.X)
	dy := math.Max(p.Y-r.Min.Y, r.Max.Y-p.Y)
	return dx*dx + dy*dy
}

// rectGap2 两 AABB 的间隙平方；相交返回 -1（无法开方，区分"接触"与"重叠"）。
func rectGap2(a, b sim.Rect) float64 {
	dx := math.Max(a.Min.X-b.Max.X, b.Min.X-a.Max.X)
	dy := math.Max(a.Min.Y-b.Max.Y, b.Min.Y-a.Max.Y)
	if dx < 0 {
		dx = 0
	}
	if dy < 0 {
		dy = 0
	}
	if dx == 0 && dy == 0 {
		return -1
	}
	return dx*dx + dy*dy
}
