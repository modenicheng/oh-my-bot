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
func toJSObservation(vm *goja.Runtime, obs *sim.Observation, selfID uint32, freeze goja.Callable) *goja.Object {
	// Lazy fields keep the scan contract (a fresh, mutable snapshot per call)
	// while avoiding construction of categories the script never reads. The
	// observation owns a copy of the scalar frame so a retained JS snapshot is
	// still independent from tickHooks.release.
	snapshot := *obs
	obs = &snapshot
	o := vm.NewObject()
	_ = o.Set("tick", float64(obs.Frame.Tick))

	defineLazyObservationField(o, "robots", vm, true, true, func() goja.Value {
		// NewArray(items...) avoids per-index property conversion while keeping
		// every returned RobotRef detached from the sim observation.
		items := make([]interface{}, 0, len(obs.Robots))
		for i := range obs.Robots {
			ro := &obs.Robots[i]
			if ro.Dead || ro.ID == selfID {
				continue
			}
			items = append(items, toJSRobotRef(vm, *ro))
		}
		return vm.NewArray(items...)
	})

	defineLazyObservationField(o, "cores", vm, true, true, func() goja.Value {
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
			_ = co.Set("value", c.Value)
			cores = append(cores, co)
		}
		return vm.NewArray(cores...)
	})

	defineLazyObservationField(o, "uplinks", vm, true, true, func() goja.Value {
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
		return vm.NewArray(uplinks...)
	})

	defineLazyObservationField(o, "projectiles", vm, true, true, func() goja.Value {
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
		return vm.NewArray(projs...)
	})

	defineLazyObservationField(o, "healthPacks", vm, true, true, func() goja.Value {
		// Health packs remain public and complete; only their JS materialization
		// is deferred until the script asks for them.
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
		return vm.NewArray(healthPacks...)
	})

	defineLazyObservationField(o, "pointDrops", vm, false, false, func() goja.Value {
		pointDrops := make([]interface{}, len(obs.PointDrops))
		for index, drop := range obs.PointDrops {
			pointDrops[index] = toJSPointDropRef(vm, drop, freeze)
		}
		return freezeObject(freeze, vm.NewArray(pointDrops...))
	})

	// 静态墙恒全量公开：每次调用新建 JS 对象，脚本改写不影响共享地图。
	defineLazyObservationField(o, "walls", vm, true, true, func() goja.Value {
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
		return vm.NewArray(walls...)
	})
	defineLazyObservationField(o, "boundaries", vm, true, true, func() goja.Value {
		boundaries := make([]interface{}, 0)
		if obs.Frame.Map != nil {
			boundaries = make([]interface{}, 0, len(obs.Frame.Map.Boundaries))
			for _, edge := range obs.Frame.Map.Boundaries {
				boundary := vm.NewObject()
				_ = boundary.Set("kind", edge.Kind)
				_ = boundary.Set("start", toJSVec2(vm, edge.Start))
				_ = boundary.Set("end", toJSVec2(vm, edge.End))
				boundaries = append(boundaries, boundary)
			}
		}
		return vm.NewArray(boundaries...)
	})

	return o
}

// defineLazyObservationField uses an accessor with a per-scan cache. The
// setter preserves the historical writable property behavior for ordinary
// fields; read-only fields pass writable=false and keep their old contract.
func defineLazyObservationField(o *goja.Object, name string, vm *goja.Runtime, enumerable, writable bool, build func() goja.Value) {
	var cached goja.Value
	getter := vm.ToValue(func(goja.FunctionCall) goja.Value {
		if cached == nil {
			cached = build()
		}
		return cached
	})
	setter := goja.Undefined()
	if writable {
		setter = vm.ToValue(func(call goja.FunctionCall) goja.Value {
			cached = call.Argument(0)
			return goja.Undefined()
		})
	}
	var enumerableFlag, configurableFlag goja.Flag
	if enumerable {
		enumerableFlag = goja.FLAG_TRUE
	} else {
		enumerableFlag = goja.FLAG_FALSE
	}
	if writable {
		configurableFlag = goja.FLAG_TRUE
	} else {
		configurableFlag = goja.FLAG_FALSE
	}
	if err := o.DefineAccessorProperty(name, getter, setter, configurableFlag, enumerableFlag); err != nil {
		panic(err)
	}
}

func toJSPointDropRef(vm *goja.Runtime, drop sim.PointDropView, freeze goja.Callable) *goja.Object {
	object := vm.NewObject()
	defineReadonly(object, "id", vm.ToValue(drop.ID))
	defineReadonly(object, "x", vm.ToValue(drop.Pos.X))
	defineReadonly(object, "y", vm.ToValue(drop.Pos.Y))
	defineReadonly(object, "points", vm.ToValue(drop.Points))
	return freezeObject(freeze, object)
}
