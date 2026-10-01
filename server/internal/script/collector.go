package script

import (
	"fmt"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// commandCollector 把 api 调用折叠为 sim.ScriptCommands。
// 指针语义：本 tick 调用过某轴 → 对应指针非 nil；未调 → nil
// （仲裁器保留人类/上次控制）。重复调用同一轴 = 后者覆盖（脚本最后意志）。
type commandCollector struct {
	out sim.ScriptCommands
}

func newCommandCollector() *commandCollector { return &commandCollector{} }

func (c *commandCollector) commands() sim.ScriptCommands { return c.out }

// ---- L0 ----

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

// toJSRobotRef RobotView → RobotRef { id, position, hp }。
func toJSRobotRef(vm *goja.Runtime, ro sim.RobotView) *goja.Object {
	o := vm.NewObject()
	_ = o.Set("id", float64(ro.ID))
	_ = o.Set("position", toJSVec2(vm, ro.Pos))
	_ = o.Set("hp", x10ToFloat(ro.HpX10))
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
