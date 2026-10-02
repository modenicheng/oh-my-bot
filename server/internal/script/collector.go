package script

import (
	"fmt"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// commandCollector 把 bot（以及兼容的 bot.api）调用折叠为
// sim.ScriptCommands。每个结果都是一个完整的单 tick 意图：调用过某轴
// 对应指针非 nil，未调用就是本 tick 中立，不会沿用上一 tick 脚本动作。
// 重复调用同一轴 = 后者覆盖（脚本最后意志）。
type commandCollector struct {
	out sim.ScriptCommands
}

func newCommandCollector() *commandCollector { return &commandCollector{} }

func (c *commandCollector) commands() sim.ScriptCommands { return c.out }

// axes 迄今实际操作过的轴位图（snippet 阶段丢弃判定用）。
func (c *commandCollector) axes() sim.AxisMask { return effectiveAxes(c.out) }

// snippetCollector 官方 snippet 模块的受限收集器：玩家本 tick 已操作
// 的轴直接丢弃（组合规则：玩家源码优先）；其余正常记录并归因 N。
// Snippet 与玩家脚本共享公开 bot API 和 L1 便利层；便利层最终仍调用
// 这些 L0 setter，因此同样受逐轴丢弃与来源归因约束。
type snippetCollector struct {
	commandCollector
	playerAxes sim.AxisMask
	snipAxes   sim.AxisMask
}

func newSnippetCollector(playerAxes sim.AxisMask) *snippetCollector {
	return &snippetCollector{playerAxes: playerAxes}
}

func (c *snippetCollector) snippetAxes() sim.AxisMask { return c.snipAxes }

func (c *snippetCollector) mark(axis sim.AxisMask, ok *bool) {
	if c.playerAxes&axis != 0 {
		*ok = false
		return
	}
	c.snipAxes |= axis
}

// ---- L0（snippet 视图：受玩家轴丢弃约束）----

func (c *snippetCollector) setMove(vx, vy float64) {
	ok := true
	c.mark(sim.AxisMove, &ok)
	if !ok {
		return
	}
	c.commandCollector.setMove(vx, vy)
}

func (c *snippetCollector) setAim(angle float64) {
	ok := true
	c.mark(sim.AxisAim, &ok)
	if !ok {
		return
	}
	c.commandCollector.setAim(angle)
}

func (c *snippetCollector) setFire() {
	ok := true
	c.mark(sim.AxisFire, &ok)
	if !ok {
		return
	}
	c.commandCollector.setFire()
}

func (c *snippetCollector) setDash() {
	ok := true
	c.mark(sim.AxisAbility, &ok)
	if !ok {
		return
	}
	c.commandCollector.setDash()
}

func (c *snippetCollector) setShield(on bool) {
	ok := true
	c.mark(sim.AxisAbility, &ok)
	if !ok {
		return
	}
	c.commandCollector.setShield(on)
}

func (c *snippetCollector) setInteract() {
	ok := true
	c.mark(sim.AxisAbility, &ok)
	if !ok {
		return
	}
	c.commandCollector.setInteract()
}

// ---- L0（玩家收集器）----

func (c *commandCollector) setMove(vx, vy float64) {
	v := sim.Vec2{X: vx, Y: vy}
	c.out.Move = &v
}

func (c *commandCollector) setAim(angle float64) {
	a := angle
	c.out.Aim = &a
}

func (c *commandCollector) setFire() {
	t := true
	c.out.Fire = &t
}

func (c *commandCollector) setDash() {
	t := true
	c.out.Dash = &t
}

func (c *commandCollector) setShield(on bool) {
	b := on
	c.out.Shield = &b
}

func (c *commandCollector) setInteract() {
	t := true
	c.out.Interact = &t
}

// setSay 3s 冷却在 sim 侧——运行时纯透传（含空串；sim 决定丢弃与否）。
func (c *commandCollector) setSay(text string) {
	s := text
	c.out.Say = &s
}

// setPulseScan 主动脉冲请求；12 能量/2s CD/32m 由 sim 校验。
func (c *commandCollector) setPulseScan() { c.out.PulseScan = true }

// ============ JS 值构建辅助 ============

// toJSVec2 sim.Vec2 → { x, y }。
func toJSVec2(vm *goja.Runtime, v sim.Vec2) *goja.Object {
	o := vm.NewObject()
	_ = o.Set("x", v.X)
	_ = o.Set("y", v.Y)
	return o
}

// toJSRobotRef RobotView → RobotRef { id, position, hp, velocity }。
func toJSRobotRef(vm *goja.Runtime, ro sim.RobotView) *goja.Object {
	o := vm.NewObject()
	_ = o.Set("id", float64(ro.ID))
	_ = o.Set("position", toJSVec2(vm, ro.Pos))
	_ = o.Set("hp", x10ToFloat(ro.HpX10))
	_ = o.Set("velocity", toJSVec2(vm, ro.Vel))
	return o
}

// argToVec2 参数可以是 { x, y } 对象（Vec2 契约）。
func argToVec2(v goja.Value) (sim.Vec2, bool) {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return sim.Vec2{}, false
	}
	o, ok := v.(*goja.Object)
	if !ok {
		return sim.Vec2{}, false
	}
	x := o.Get("x")
	y := o.Get("y")
	if x == nil || y == nil || goja.IsUndefined(x) || goja.IsUndefined(y) {
		return sim.Vec2{}, false
	}
	return sim.Vec2{X: x.ToFloat(), Y: y.ToFloat()}, true
}

// argEntityID 参数可以是 RobotRef { id } 或裸 number。
func argEntityID(v goja.Value) (uint32, bool) {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return 0, false
	}
	if o, ok := v.(*goja.Object); ok {
		id := o.Get("id")
		if id != nil && !goja.IsUndefined(id) && !goja.IsNull(id) {
			return uint32(id.ToInteger()), true
		}
		return 0, false
	}
	return uint32(v.ToInteger()), true
}

// x10ToFloat HP/Energy ×10 定点 → JS number。
func x10ToFloat(v int32) float64 { return float64(v) / 10 }

// phaseName Phase → 手册 GameInfo.phase 字符串。
func phaseName(p sim.Phase) string {
	switch p {
	case sim.PhaseCoreOpen:
		return "CORE_OPEN"
	default:
		return "OUTER_RING"
	}
}

// mapSeedOf nil-safe 取 MapDef.Seed。
func mapSeedOf(m *sim.MapDef) float64 {
	if m == nil {
		return 0
	}
	return float64(m.Seed)
}

// throwValue 在 VM 内抛 JS 异常（L1 参数校验失败等）。
func throwValue(vm *goja.Runtime, msg string) {
	panic(vm.NewTypeError(msg))
}

var _ = fmt.Sprintf // keep fmt for future use
