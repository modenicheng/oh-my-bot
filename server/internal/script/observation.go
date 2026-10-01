package script

import (
	"github.com/dop251/goja"
	"strconv"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// toJSObservation Observation → index.ts Observation 形状（scan() 返回值）：
//
//	{ tick, robots: [{id, position, hp, isPartner}],
//	  cores: [{id, x, y}], uplinks: [{id, x, y, ready, holder?}],
//	  projectiles: [{id, x, y}], walls: [{id, min:{x,y}, max:{x,y}}] }
//
// 手册：可见机器人不含自己；partner 恒在。静态墙是公开地图结构（挡移动+
// 弹丸+视线），不随视野半径/遮挡裁剪，也不含任何动态实体信息。
func toJSObservation(vm *goja.Runtime, obs *sim.Observation, selfID uint32) *goja.Object {
	o := vm.NewObject()
	_ = o.Set("tick", float64(obs.Frame.Tick))

	robots := vm.NewArray()
	n := 0
	for i := range obs.Robots {
		ro := &obs.Robots[i]
		if ro.Dead || ro.ID == selfID {
			continue
		}
		_ = robots.Set(strconv.Itoa(n), toJSRobotRef(vm, *ro, obs.IsPartner(ro.ID)))
		n++
	}
	_ = o.Set("robots", robots)

	cores := vm.NewArray()
	n = 0
	for i := range obs.Cores {
		c := &obs.Cores[i]
		if !c.Alive {
			continue
		}
		co := vm.NewObject()
		_ = co.Set("id", float64(c.ID))
		_ = co.Set("x", c.Pos.X)
		_ = co.Set("y", c.Pos.Y)
		_ = cores.Set(strconv.Itoa(n), co)
		n++
	}
	_ = o.Set("cores", cores)

	uplinks := vm.NewArray()
	n = 0
	for i := range obs.Uplinks {
		u := &obs.Uplinks[i]
		uo := vm.NewObject()
		_ = uo.Set("id", float64(u.ID))
		_ = uo.Set("x", u.Pos.X)
		_ = uo.Set("y", u.Pos.Y)
		_ = uo.Set("ready", u.Active && u.HackingID == 0)
		if u.HackingID != 0 {
			_ = uo.Set("holder", float64(u.HackingID))
		}
		_ = uplinks.Set(strconv.Itoa(n), uo)
		n++
	}
	_ = o.Set("uplinks", uplinks)

	projs := vm.NewArray()
	for i := range obs.Projectiles {
		p := &obs.Projectiles[i]
		po := vm.NewObject()
		_ = po.Set("id", float64(p.ID))
		_ = po.Set("x", p.Pos.X)
		_ = po.Set("y", p.Pos.Y)
		_ = projs.Set(strconv.Itoa(i), po)
	}
	_ = o.Set("projectiles", projs)

	// 静态墙恒全量公开：每次调用新建 JS 对象，脚本改写不影响共享地图。
	walls := vm.NewArray()
	if obs.Frame.Map != nil {
		for i, w := range obs.Frame.Map.Walls {
			wo := vm.NewObject()
			_ = wo.Set("id", float64(w.ID))
			_ = wo.Set("min", toJSVec2(vm, w.Min))
			_ = wo.Set("max", toJSVec2(vm, w.Max))
			_ = walls.Set(strconv.Itoa(i), wo)
		}
	}
	_ = o.Set("walls", walls)

	return o
}
