package script

import (
	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// toJSObservation Observation → index.ts Observation 形状（scan() 返回值）：
//
//	{ tick, robots: [{id, position, hp}],
//	  cores: [{id, x, y}], uplinks: [{id, x, y, ready, holder?}],
//	  projectiles: [{id, owner, x, y, heading}],
//	  healthPacks: [{id, x, y, available, respawnInS}],
//	  walls: [{id, min:{x,y}, max:{x,y}}] }
//
// 可见机器人不含自己。健康包与静态墙是公开地图结构，不随视野半径/
// 遮挡裁剪，也不含任何动态机器人信息。每次调用均构建独立 JS 快照。
func toJSObservation(vm *goja.Runtime, obs *sim.Observation, selfID uint32) *goja.Object {
	o := vm.NewObject()
	_ = o.Set("tick", float64(obs.Frame.Tick))

	// 数组走 NewArray(items...) 批量初始化：一次分配 values 切片，避免
	// Set("N") 逐元素走 setOwnStr 哈希查找 + strconv 分配（64 机对局每
	// tick 每 bot 省 ~1.4K allocs；元素对象仍每调用全新，手册「每次调
	// 用都给新对象」契约不变）。
	if n := len(obs.Robots); n > 0 {
		items := make([]interface{}, 0, n-1)
		for i := range obs.Robots {
			ro := &obs.Robots[i]
			if ro.Dead || ro.ID == selfID {
				continue
			}
			items = append(items, toJSRobotRef(vm, *ro))
		}
		_ = o.Set("robots", vm.NewArray(items...))
	} else {
		_ = o.Set("robots", vm.NewArray())
	}

	cores := make([]interface{}, 0, len(obs.Cores))
	for i := range obs.Cores {
		c := &obs.Cores[i]
		if !c.Alive {
			continue
		}
		co := vm.NewObject()
		_ = co.Set("id", float64(c.ID))
		_ = co.Set("x", c.Pos.X)
		_ = co.Set("y", c.Pos.Y)
		cores = append(cores, co)
	}
	_ = o.Set("cores", vm.NewArray(cores...))

	uplinks := make([]interface{}, 0, len(obs.Uplinks))
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
		uplinks = append(uplinks, uo)
	}
	_ = o.Set("uplinks", vm.NewArray(uplinks...))

	projs := make([]interface{}, 0, len(obs.Projectiles))
	for i := range obs.Projectiles {
		p := &obs.Projectiles[i]
		po := vm.NewObject()
		_ = po.Set("id", float64(p.ID))
		_ = po.Set("owner", float64(p.Owner))
		_ = po.Set("x", p.Pos.X)
		_ = po.Set("y", p.Pos.Y)
		_ = po.Set("heading", p.Heading)
		projs = append(projs, po)
	}
	_ = o.Set("projectiles", vm.NewArray(projs...))

	// 健康包恒全量公开：状态来自冻结 Observation，而非动态机器人或 MapDef。
	healthPacks := make([]interface{}, 0, len(obs.HealthPacks))
	for i := range obs.HealthPacks {
		pack := &obs.HealthPacks[i]
		po := vm.NewObject()
		_ = po.Set("id", float64(pack.ID))
		_ = po.Set("x", pack.Pos.X)
		_ = po.Set("y", pack.Pos.Y)
		_ = po.Set("available", pack.Available)
		_ = po.Set("respawnInS", float64(pack.RespawnInS))
		healthPacks = append(healthPacks, po)
	}
	_ = o.Set("healthPacks", vm.NewArray(healthPacks...))

	// 静态墙恒全量公开：每次调用新建 JS 对象，脚本改写不影响共享地图。
	var walls []interface{}
	if obs.Frame.Map != nil {
		walls = make([]interface{}, 0, len(obs.Frame.Map.Walls))
		for i := range obs.Frame.Map.Walls {
			w := &obs.Frame.Map.Walls[i]
			wo := vm.NewObject()
			_ = wo.Set("id", float64(w.ID))
			_ = wo.Set("min", toJSVec2(vm, w.Min))
			_ = wo.Set("max", toJSVec2(vm, w.Max))
			walls = append(walls, wo)
		}
	}
	_ = o.Set("walls", vm.NewArray(walls...))

	return o
}
