package script

import (
	"strconv"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// toJSObservation Observation → index.ts Observation 形状（scan() 返回值）：
//
//	{ tick, robots: [{id, position, hp}],
//	  cores: [{id, x, y}], uplinks: [{id, x, y, ready, holder?}],
//	  projectiles: [{id, x, y}],
//	  healthPacks: [{id, x, y, available, respawnInS}],
//	  walls: [{id, min:{x,y}, max:{x,y}}] }
//
// 可见机器人不含自己。健康包与静态墙是公开地图结构，不随视野半径/
// 遮挡裁剪，也不含任何动态机器人信息。每次调用均构建独立 JS 快照。
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
		_ = robots.Set(strconv.Itoa(n), toJSRobotRef(vm, *ro))
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

	// 健康包恒全量公开：状态来自冻结 Observation，而非动态机器人或 MapDef。
	healthPacks := vm.NewArray()
	for i, pack := range obs.HealthPacks {
		po := vm.NewObject()
		_ = po.Set("id", float64(pack.ID))
		_ = po.Set("x", pack.Pos.X)
		_ = po.Set("y", pack.Pos.Y)
		_ = po.Set("available", pack.Available)
		_ = po.Set("respawnInS", float64(pack.RespawnInS))
		_ = healthPacks.Set(strconv.Itoa(i), po)
	}
	_ = o.Set("healthPacks", healthPacks)

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
