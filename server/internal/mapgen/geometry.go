package mapgen

import (
	"math"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// dirCount 为方向表分辨率：48 步 × 7.5° = 360°。扇区轴（k*45° = 6k 步）
// 与 Uplink 错位角（k*45°+22.5° = 6k+3 步）都是表上精确点——生成路径零
// 三角函数调用（浮点乘加 + 字面量表），保证跨平台 bit 级确定性。
const dirCount = 48

// dirTable 为 7.5° 步进的单位向量字面量表（6 位小数）。TestDirTable 校验
// 单位长度与相邻夹角，防止手抄笔误进入产出。
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

// slotDirection interpolates the literal table and normalizes the chord.
// Bounded slot jitter uses no platform-dependent trigonometric functions.
func slotDirection(step float64) sim.Vec2 {
	base := int(math.Floor(step))
	f := step - float64(base)
	p := dirAt(base).Scale(1 - f).Add(dirAt(base + 1).Scale(f))
	return p.Scale(1 / math.Sqrt(p.X*p.X+p.Y*p.Y))
}

// r2 = √2/2（45° 旋转系数）。用字面量而非 math.Sqrt2/2，与 rot45 的
// 乘加序列共同构成确定性算术。
const r2 = 0.7071067811865476

// rot90 为绕原点的 90° 整格旋转（精确算术：(x,y) → (-y,x)）。
func rot90(p sim.Vec2) sim.Vec2 { return sim.Vec2{X: -p.Y, Y: p.X} }

// rot45 为绕原点的 45° 旋转（(x,y) → ((x−y)·r2, (x+y)·r2)）。产出经
// IEEE754 乘加后完全可复现；用于掩体中心的八分对称标记。
func rot45(p sim.Vec2) sim.Vec2 {
	return sim.Vec2{X: (p.X - p.Y) * r2, Y: (p.X + p.Y) * r2}
}

// rect 为 mapgen 内部轴对齐矩形（与 sim.Rect/Min-Max 语义同构）。
type rect struct {
	MinX, MinY, MaxX, MaxY float64
}

// rectAt 构造中心 p、半边 (hx,hy) 的矩形。
func rectAt(p sim.Vec2, hx, hy float64) rect {
	return rect{MinX: p.X - hx, MinY: p.Y - hy, MaxX: p.X + hx, MaxY: p.Y + hy}
}

// wallRect 将 sim.Wall 转为内部 rect。
func wallRect(w sim.Wall) rect {
	return rect{MinX: w.Min.X, MinY: w.Min.Y, MaxX: w.Max.X, MaxY: w.Max.Y}
}

// nearestDist2 点到矩形最近距离的平方（点在内为 0）。只用 min/max/乘加，
// 无 Sqrt，保证确定性。
func nearestDist2(r rect, p sim.Vec2) float64 {
	dx := max(r.MinX-p.X, p.X-r.MaxX)
	dy := max(r.MinY-p.Y, p.Y-r.MaxY)
	if dx < 0 {
		dx = 0
	}
	if dy < 0 {
		dy = 0
	}
	return dx*dx + dy*dy
}

// gap2 两矩形间隙的平方；相交或接触返回 -1。
func gap2(a, b rect) float64 {
	dx := max(a.MinX-b.MaxX, b.MinX-a.MaxX)
	dy := max(a.MinY-b.MaxY, b.MinY-a.MaxY)
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
