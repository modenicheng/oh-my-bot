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

// tickHooks 承载每 tick 变化的执行环境（帧数据 + 命令收集器）。
// 原生方法闭包在 VM 装载时创建一次（vmBindings），跨 tick 复用；闭包
// 捕获 hooks 指针，每 tick 只切换字段值，不重建函数对象。
//
// 语义边界（手册 data.md「生命周期」契约保持不变）：
//   - bot 壳、self、game、scan() 返回值仍每帧 / 每调用全新构建；
//   - 方法对象身份跨 tick 稳定：脚本把 bot.move 存到全局、下一 tick
//     调用时写入的是**当帧**的命令收集器（旧实现写入死收集器被静默
//     丢弃——缓存后语义反而更正确）。
type tickHooks struct {
	vm       *goja.Runtime
	frame    sim.ScriptFrame
	cmd      commandSink
	scanMemo *goja.Object // pulseScan 共享快照（每 tick 每阶段重置）
}

// vmBindings 装载期创建的 per-VM 原生方法缓存。
//
// 性能背景（2026-10 bit-333 perf）：goja newNativeFunc/setOwnStr 占重载
// 帧分配的 ~40%，其中每 tick 重复包装 ~20 个原生方法是纯浪费——函数
// 行为只依赖 hooks 指针。Hot Swap（loadLocked 成功）时随候选 VM 整体
// 重建，杜绝跨 VM 借用（goja 禁止 Object 跨 Runtime）。
type vmBindings struct {
	hooks *tickHooks
	fns   map[string]goja.Value
}

// newVMBindings 在候选 VM 校验通过后调用（调用方持 r.mu）。
func newVMBindings(vm *goja.Runtime) *vmBindings {
	h := &tickHooks{vm: vm}
	b := &vmBindings{hooks: h, fns: make(map[string]goja.Value, 20)}
	vmToFns := b.fns

	vmToFns["move"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		h.cmd.setMove(call.Argument(0).ToFloat(), call.Argument(1).ToFloat())
		return goja.Undefined()
	})

	// aimAt(angle)：L0 语义——绝对角度（弧度）。L1 同名重载：
	// 传入 RobotRef 对象时按实体角度处理（index.ts L1 声明）。
	vmToFns["aimAt"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		arg := call.Argument(0)
		if o, ok := arg.(*goja.Object); ok && o.Get("id") != nil && !goja.IsUndefined(o.Get("id")) {
			aimAtEntity(vm, &h.frame.Obs, h.frame.Self, arg, h.cmd)
		} else {
			h.cmd.setAim(arg.ToFloat())
		}
		return goja.Undefined()
	})

	vmToFns["fire"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		h.cmd.setFire()
		return goja.Undefined()
	})

	vmToFns["dash"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		h.cmd.setDash()
		return goja.Undefined()
	})

	vmToFns["shield"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		h.cmd.setShield(call.Argument(0).ToBoolean())
		return goja.Undefined()
	})

	vmToFns["interact"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		h.cmd.setInteract()
		return goja.Undefined()
	})

	// say：3s 冷却在 sim 侧——运行时纯透传。
	vmToFns["say"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		h.cmd.setSay(call.Argument(0).String())
		return goja.Undefined()
	})

	// moveTo(pos: Vec2)：保持历史直线语义，仅转为单位向量 move 输出。
	vmToFns["moveTo"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		pos, ok := argToVec2(call.Argument(0))
		if !ok {
			throwValue(vm, "moveTo: expected { x, y }")
		}
		d := pos.Sub(h.frame.Self.Pos)
		if L := d.Len(); L > 1e-9 {
			h.cmd.setMove(d.X/L, d.Y/L)
		}
		return goja.Undefined()
	})

	// navigateTo(pos: Vec2)：服务器确定性静态寻路；仅记录本 tick 的移动方向。
	vmToFns["navigateTo"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		pos, ok := argToVec2(call.Argument(0))
		if !ok {
			throwValue(vm, "navigateTo: expected { x, y }")
		}
		obs := &h.frame.Obs
		d := nav.Direction(obs.Frame.Map, obs.Frame.Phase, h.frame.Self.Pos, pos)
		h.cmd.setMove(d.X, d.Y)
		return goja.Undefined()
	})

	vmToFns["nearestEnemy"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		obs := &h.frame.Obs
		self := h.frame.Self
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

	vmToFns["nearestCore"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		obs := &h.frame.Obs
		self := h.frame.Self
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

	vmToFns["nearestUplink"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		obs := &h.frame.Obs
		self := h.frame.Self
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

	// scan()：每调用返回独立新快照（手册契约：「每次调用都给新对象」）。
	vmToFns["scan"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		return toJSObservation(vm, &h.frame.Obs, h.frame.Self.ID)
	})

	// pulseScan()：请求主动脉冲（12 能量/2s CD/32m 由 sim 校验），
	// 返回本 tick 的共享感知快照（手册 data.md：「pulseScan() 也始终
	// 返回这份快照」——同 tick 内与自身共享，与 scan() 仍互为新对象）。
	vmToFns["pulseScan"] = vm.ToValue(func(call goja.FunctionCall) goja.Value {
		h.cmd.setPulseScan()
		if h.scanMemo == nil {
			h.scanMemo = toJSObservation(vm, &h.frame.Obs, h.frame.Self.ID)
		}
		return h.scanMemo
	})

	return b
}

// release 清空 hooks 引用（tick 结束调用）：避免 64 个 runtime 各自
// 持有最后一帧的 sim.ScriptFrame 副本（含全量机器人视图）延迟回收。
func (h *tickHooks) release() {
	h.frame = sim.ScriptFrame{}
	h.cmd = nil
	h.scanMemo = nil
}

// buildTickContext 组装 JS 侧 BotContext（runtime.ts 契约）：
//
//	{ self, game, scan(), move(), ..., api }
//
// bot 壳、self、game 每次调用全新构建（手册「每帧重建」）；方法取自
// 装载期缓存，只切换 hooks 指向当前帧与收集器。全部 metadata 为每
// tick 独立快照，方法闭包只记录命令。
func (b *vmBindings) buildTickContext(frame sim.ScriptFrame, cmd commandSink) *goja.Object {
	h := b.hooks
	h.frame = frame
	h.cmd = cmd
	h.scanMemo = nil

	vm := h.vm
	self := frame.Self
	obs := &frame.Obs

	// ---- self: Self { hp, energy, position, velocity } ----
	selfObj := vm.NewObject()
	defineReadonly(selfObj, "id", vm.ToValue(self.ID))
	defineReadonly(selfObj, "hp", vm.ToValue(sim.FromX10(self.HpX10)))
	defineReadonly(selfObj, "energy", vm.ToValue(sim.FromX10(self.EnergyX10)))
	defineReadonly(selfObj, "position", readonlyVec2(vm, self.Pos))
	defineReadonly(selfObj, "velocity", readonlyVec2(vm, self.Vel))

	// ---- game: GameInfo { time, timeLeft, phase, mapSeed } ----
	gameObj := vm.NewObject()
	defineReadonly(gameObj, "time", vm.ToValue(float64(obs.Frame.Tick)/60))
	defineReadonly(gameObj, "timeLeft", vm.ToValue(float64(obs.Frame.TimeLeftS)))
	defineReadonly(gameObj, "phase", vm.ToValue(phaseName(obs.Frame.Phase)))
	defineReadonly(gameObj, "mapSeed", vm.ToValue(mapSeedOf(obs.Frame.Map)))

	bot := vm.NewObject()
	for name, fn := range b.fns {
		_ = bot.Set(name, fn)
	}
	defineReadonly(bot, "self", selfObj)
	defineReadonly(bot, "game", gameObj)
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
