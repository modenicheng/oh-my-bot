package script

import (
	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// toJSObservation Observation → index.ts Observation 形状（scan() 返回值）：
//
//	{ tick, robots: [{id, position, hp, isPartner}],
//	  cores: [{id, x, y}], uplinks: [{id, x, y, ready, holder?}],
//	  projectiles: [{id, x, y}] }
//
// 手册：可见机器人不含自己；partner 恒在。
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
		_ = robots.Set(n, toJSRobotRef(vm, *ro, obs.IsPartner(ro.ID)))
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
		_ = cores.Set(n, co)
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
		_ = uplinks.Set(n, uo)
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
		_ = projs.Set(i, po)
	}
	_ = o.Set("projectiles", projs)

	return o
}
