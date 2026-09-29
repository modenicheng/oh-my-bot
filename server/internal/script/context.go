package script

import (
	"math"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// buildTickContext 组装 JS 侧 TickContext（runtime.ts 契约）：
//
//	{ self: Self, game: GameInfo, scan(): Observation, api: L0 & L1 }
//
// 全部字段为只读快照；api 方法闭包捕获 frame/cmd，不触碰 Sim 内部状态。
func buildTickContext(vm *goja.Runtime, frame sim.ScriptFrame, cmd *commandCollector) *goja.Object {
	self := frame.Self
	obs := &frame.Obs

	// ---- self: Self { hp, energy, position, velocity } ----
	selfObj := vm.NewObject()
	_ = selfObj.Set("hp", x10ToFloat(self.HpX10))
	_ = selfObj.Set("energy", x10ToFloat(self.EnergyX10))
	_ = selfObj.Set("position", toJSVec2(vm, self.Pos))
	_ = selfObj.Set("velocity", toJSVec2(vm, self.Vel))

	// ---- game: GameInfo { time, timeLeft, phase, mapSeed } ----
	gameObj := vm.NewObject()
	_ = gameObj.Set("time", float64(obs.Frame.Tick)/60)
	_ = gameObj.Set("timeLeft", float64(obs.Frame.TimeLeftS))
	_ = gameObj.Set("phase", phaseName(obs.Frame.Phase))
	_ = gameObj.Set("mapSeed", mapSeedOf(obs.Frame.Map))

	ctx := vm.NewObject()
	_ = ctx.Set("self", selfObj)
	_ = ctx.Set("game", gameObj)
	_ = ctx.Set("scan", func(call goja.FunctionCall) goja.Value {
		return toJSObservation(vm, obs, self.ID)
	})
	_ = ctx.Set("api", buildAPI(vm, frame, cmd))
	return ctx
}

// buildAPI 绑定 L0 原语 + L1 便利层（index.ts 契约）。所有方法只记录意图，
// 物理结算归 sim。
func buildAPI(vm *goja.Runtime, frame sim.ScriptFrame, cmd *commandCollector) *goja.Object {
	api := vm.NewObject()
	self := frame.Self
	obs := &frame.Obs

	// ---------- L0 原语 ----------

	_ = api.Set("move", func(call goja.FunctionCall) goja.Value {
		vx := call.Argument(0).ToFloat()
		vy := call.Argument(1).ToFloat()
		cmd.setMove(vx, vy)
		return goja.Undefined()
	})

	// aimAt(angle)：L0 语义——绝对角度（弧度）。L1 同名重载在下方覆盖：
	// 传入 RobotRef 对象时按实体角度处理（index.ts L1 声明）。
	_ = api.Set("aimAt", func(call goja.FunctionCall) goja.Value {
		arg := call.Argument(0)
		if o, ok := arg.(*goja.Object); ok && o.Get("id") != nil && !goja.IsUndefined(o.Get("id")) {
			// L1 重载：aimAt(target: RobotRef)。
			aimAtEntity(vm, obs, self, arg, cmd)
		} else {
			cmd.setAim(arg.ToFloat())
		}
		return goja.Undefined()
	})

	_ = api.Set("fire", func(call goja.FunctionCall) goja.Value {
		cmd.setFire()
		return goja.Undefined()
	})

	_ = api.Set("dash", func(call goja.FunctionCall) goja.Value {
		cmd.setDash()
		return goja.Undefined()
	})

	_ = api.Set("shield", func(call goja.FunctionCall) goja.Value {
		cmd.setShield(call.Argument(0).ToBoolean())
		return goja.Undefined()
	})

	_ = api.Set("interact", func(call goja.FunctionCall) goja.Value {
		cmd.setInteract()
		return goja.Undefined()
	})

	// say：3s 冷却在 sim 侧——运行时纯透传。
	_ = api.Set("say", func(call goja.FunctionCall) goja.Value {
		cmd.setSay(call.Argument(0).String())
		return goja.Undefined()
	})

	// ---------- L1 便利层 ----------

	// moveTo(pos: Vec2)：内部转为单位向量 move 输出。
	_ = api.Set("moveTo", func(call goja.FunctionCall) goja.Value {
		pos, ok := argToVec2(call.Argument(0))
		if !ok {
			throwValue(vm, "moveTo: expected { x, y }")
		}
		d := pos.Sub(self.Pos)
		if L := d.Len(); L > 1e-9 {
			cmd.setMove(d.X/L, d.Y/L)
		}
		return goja.Undefined()
	})

	_ = api.Set("nearestEnemy", func(call goja.FunctionCall) goja.Value {
		var best *sim.RobotView
		bestD := math.Inf(1)
		for i := range obs.Robots {
			ro := &obs.Robots[i]
			if ro.ID == self.ID || ro.Dead || obs.IsPartner(ro.ID) {
				continue
			}
			if d := ro.Pos.Sub(self.Pos).Len(); d < bestD {
				bestD, best = d, ro
			}
		}
		if best == nil {
			return goja.Null()
		}
		return toJSRobotRef(vm, *best, false)
	})

	_ = api.Set("nearestCore", func(call goja.FunctionCall) goja.Value {
		var best *sim.Vec2
		bestD := math.Inf(1)
		for i := range obs.Cores {
			c := &obs.Cores[i]
			if !c.Alive {
				continue
			}
			if d := c.Pos.Sub(self.Pos).Len(); d < bestD {
				bestD = d
				best = &c.Pos
			}
		}
		if best == nil {
			return goja.Null()
		}
		return toJSVec2(vm, *best)
	})

	_ = api.Set("nearestUplink", func(call goja.FunctionCall) goja.Value {
		var best *sim.Vec2
		bestD := math.Inf(1)
		for i := range obs.Uplinks {
			u := &obs.Uplinks[i]
			if !u.Active {
				continue
			}
			if d := u.Pos.Sub(self.Pos).Len(); d < bestD {
				bestD = d
				best = &u.Pos
			}
		}
		if best == nil {
			return goja.Null()
		}
		return toJSVec2(vm, *best)
	})

	// partner()：本局搭档（奇数局末位玩家为 null）。
	_ = api.Set("partner", func(call goja.FunctionCall) goja.Value {
		if obs.PartnerID == 0 {
			return goja.Null()
		}
		for i := range obs.Robots {
			if obs.Robots[i].ID == obs.PartnerID {
				return toJSRobotRef(vm, obs.Robots[i], true)
			}
		}
		return goja.Null()
	})

	// pulseScan()：请求主动脉冲（12 能量/2s CD/32m 由 sim 校验），
	// 返回当前感知快照（脉冲生效后的扩展视野由 sim 下一 tick 的 Observation 提供）。
	_ = api.Set("pulseScan", func(call goja.FunctionCall) goja.Value {
		cmd.setPulseScan()
		return toJSObservation(vm, obs, self.ID)
	})

	return api
}

// aimAtEntity L1 重载实现：按可见实体位置计算角度。不可见实体抛 JS TypeError。
func aimAtEntity(vm *goja.Runtime, obs *sim.Observation, self sim.RobotView, arg goja.Value, cmd *commandCollector) {
	id, ok := argEntityID(arg)
	if !ok {
		throwValue(vm, "aimAt: expected RobotRef { id }")
	}
	for i := range obs.Robots {
		ro := &obs.Robots[i]
		if ro.ID == id {
			d := ro.Pos.Sub(self.Pos)
			cmd.setAim(math.Atan2(d.Y, d.X))
			return
		}
	}
	throwValue(vm, "aimAt: entity not visible")
}
