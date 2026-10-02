package script

import (
	"math"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/nav"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// commandSink 是 tick 上下文的命令出口：玩家阶段用 *commandCollector，
// snippet 阶段用 *snippetCollector（玩家轴丢弃 + N 归因）。
type commandSink interface {
	setMove(vx, vy float64)
	setAim(angle float64)
	setFire()
	setDash()
	setShield(on bool)
	setInteract()
	setSay(text string)
	setPulseScan()
}

var (
	_ commandSink = (*commandCollector)(nil)
	_ commandSink = (*snippetCollector)(nil)
)

// buildTickContext 组装 JS 侧 BotContext（runtime.ts 契约）：
//
//	{ self, game, scan(), move(), ..., api }
//
// 新脚本直接使用 flat bot.move()/bot.scan()；api 保留为 deprecated
// 兼容引用。全部 metadata 为每 tick 独立快照，方法闭包只记录命令。
func buildTickContext(vm *goja.Runtime, frame sim.ScriptFrame, cmd commandSink) *goja.Object {
	self := frame.Self
	obs := &frame.Obs

	// ---- self: Self { hp, energy, position, velocity } ----
	selfObj := vm.NewObject()
	defineReadonly(selfObj, "id", vm.ToValue(self.ID))
	defineReadonly(selfObj, "hp", vm.ToValue(x10ToFloat(self.HpX10)))
	defineReadonly(selfObj, "energy", vm.ToValue(x10ToFloat(self.EnergyX10)))
	defineReadonly(selfObj, "position", readonlyVec2(vm, self.Pos))
	defineReadonly(selfObj, "velocity", readonlyVec2(vm, self.Vel))

	// ---- game: GameInfo { time, timeLeft, phase, mapSeed } ----
	gameObj := vm.NewObject()
	defineReadonly(gameObj, "time", vm.ToValue(float64(obs.Frame.Tick)/60))
	defineReadonly(gameObj, "timeLeft", vm.ToValue(float64(obs.Frame.TimeLeftS)))
	defineReadonly(gameObj, "phase", vm.ToValue(phaseName(obs.Frame.Phase)))
	defineReadonly(gameObj, "mapSeed", vm.ToValue(mapSeedOf(obs.Frame.Map)))

	bot := buildAPI(vm, frame, cmd)
	defineReadonly(bot, "self", selfObj)
	defineReadonly(bot, "game", gameObj)
	_ = bot.Set("scan", func(call goja.FunctionCall) goja.Value {
		return toJSObservation(vm, obs, self.ID)
	})
	// Legacy compatibility: old tick(ctx) { ctx.api.move(...) } scripts keep
	// running, while the same methods are canonical on the bot object itself.
	defineReadonly(bot, "api", bot)
	return bot
}

func defineReadonly(obj *goja.Object, name string, value goja.Value) {
	_ = obj.DefineDataProperty(name, value, goja.FLAG_FALSE, goja.FLAG_FALSE, goja.FLAG_TRUE)
}

func readonlyVec2(vm *goja.Runtime, v sim.Vec2) *goja.Object {
	o := vm.NewObject()
	defineReadonly(o, "x", vm.ToValue(v.X))
	defineReadonly(o, "y", vm.ToValue(v.Y))
	return o
}

// buildAPI 绑定 L0 原语 + L1 便利层（index.ts 契约）。所有方法只记录意图，
// 物理结算归 sim。
func buildAPI(vm *goja.Runtime, frame sim.ScriptFrame, cmd commandSink) *goja.Object {
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

	// moveTo(pos: Vec2)：保持历史直线语义，仅转为单位向量 move 输出。
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

	// navigateTo(pos: Vec2)：服务器确定性静态寻路；仅记录本 tick 的移动方向。
	_ = api.Set("navigateTo", func(call goja.FunctionCall) goja.Value {
		pos, ok := argToVec2(call.Argument(0))
		if !ok {
			throwValue(vm, "navigateTo: expected { x, y }")
		}
		d := nav.Direction(obs.Frame.Map, obs.Frame.Phase, self.Pos, pos)
		cmd.setMove(d.X, d.Y)
		return goja.Undefined()
	})

	_ = api.Set("nearestEnemy", func(call goja.FunctionCall) goja.Value {
		var best *sim.RobotView
		bestD := math.Inf(1)
		for i := range obs.Robots {
			ro := &obs.Robots[i]
			if ro.ID == self.ID || ro.Dead {
				continue
			}
			if d := ro.Pos.Sub(self.Pos).Len(); d < bestD {
				bestD, best = d, ro
			}
		}
		if best == nil {
			return goja.Null()
		}
		return toJSRobotRef(vm, *best)
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

	// pulseScan()：请求主动脉冲（12 能量/2s CD/32m 由 sim 校验），
	// 返回当前感知快照（脉冲生效后的扩展视野由 sim 下一 tick 的 Observation 提供）。
	_ = api.Set("pulseScan", func(call goja.FunctionCall) goja.Value {
		cmd.setPulseScan()
		return toJSObservation(vm, obs, self.ID)
	})

	return api
}

// aimAtEntity L1 重载实现：按可见实体位置计算角度。不可见实体抛 JS TypeError。
func aimAtEntity(vm *goja.Runtime, obs *sim.Observation, self sim.RobotView, arg goja.Value, cmd commandSink) {
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
