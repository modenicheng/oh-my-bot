package sim

import (
	"math"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

const allAxes = AxisMove | AxisAim | AxisFire | AxisAbility

// GameplayReplaySink adds controls absent from ClientInput without changing
// ReplaySink or EventSink. Workers must submit results on the Sim owner thread.
type GameplayReplaySink interface {
	OnControl(tick, robotID uint32, control ControlRecord)
}
type ControlRecord struct {
	Script       *ScriptCommands `json:"script,omitempty"`
	ScriptFailed bool            `json:"script_failed,omitempty"`
	Toggles      uint32          `json:"toggles,omitempty"`
	Respawn      bool            `json:"respawn,omitempty"`
	Say          string          `json:"say,omitempty"`
}
type controlRecord struct {
	RobotID uint32
	Control ControlRecord
}

func copyPointer[T any](v *T) *T {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}
func cloneCommands(v *ScriptCommands) *ScriptCommands {
	if v == nil {
		return nil
	}
	c := *v
	c.Move, c.Aim, c.Fire = copyPointer(v.Move), copyPointer(v.Aim), copyPointer(v.Fire)
	c.Dash, c.Shield, c.Interact, c.Say = copyPointer(v.Dash), copyPointer(v.Shield), copyPointer(v.Interact), copyPointer(v.Say)
	return &c
}

// ApplyScriptCommands queues one detached worker result for the next tick.
// Every script result is a complete tick intent: nil members mean that action
// is idle for this tick. Human-held axes remain independent and persistent.
func (s *Sim) ApplyScriptCommands(id uint32, commands ScriptCommands) bool {
	i, ok := s.index[id]
	if !ok || s.ended {
		return false
	}
	if (commands.Move != nil && !commands.Move.finite()) || (commands.Aim != nil && (math.IsNaN(*commands.Aim) || math.IsInf(*commands.Aim, 0))) {
		s.ClearScriptAxes(id)
		return false
	}
	c := &s.robots[i].Control
	c.PendingScript, c.ScriptPending, c.ScriptFailed = cloneCommands(&commands), true, false
	return true
}

// Say queues manual chat for the next tick, sharing script say's cooldown.
// Like input, it must be called while the Sim owner is locked.
func (s *Sim) Say(id uint32, text string) bool {
	i, ok := s.index[id]
	if !ok || s.ended {
		return false
	}
	r := &s.robots[i]
	if r.State == Dead || s.tick+1 < r.Combat.SayReady || r.Control.PendingSay != "" {
		return false
	}
	text = normalizeSay(text)
	if text == "" {
		return false
	}
	r.Control.PendingSay = text
	return true
}

// ClearScriptAxes queues an idle script tick for a failed/timed-out result;
// human overrides are retained. It never clears physical aim state.
func (s *Sim) ClearScriptAxes(id uint32) bool {
	i, ok := s.index[id]
	if !ok || s.ended {
		return false
	}
	c := &s.robots[i].Control
	c.PendingScript, c.ScriptPending, c.ScriptFailed = nil, true, true
	return true
}

// SetAssist sets the initial room preference during Match assembly. Runtime
// gameplay should use AssistToggle so replay records the user action.
func (s *Sim) SetAssist(id uint32, on bool) bool {
	i, ok := s.index[id]
	if !ok || s.ended {
		return false
	}
	s.robots[i].Control.Assist = on
	if !on {
		s.robots[i].Control.Script, s.robots[i].Control.ScriptAxes = ArbitratedInput{}, 0
	}
	return true
}

// AssistToggle queues an event, not a desired boolean. Switching ON explicitly
// gives all axes back; subsequent human operations still take priority.
func (s *Sim) AssistToggle(id uint32) bool {
	i, ok := s.index[id]
	if !ok || s.ended {
		return false
	}
	s.robots[i].Control.ToggleCount++
	return true
}

func mergeInput(old, in Input) Input {
	if in.AxisMask&AxisMove == 0 {
		in.MoveX, in.MoveY = old.MoveX, old.MoveY
	}
	if in.AxisMask&AxisAim == 0 {
		in.Aim = old.Aim
	}
	if in.AxisMask&AxisFire == 0 {
		in.Fire = old.Fire
	}
	if in.AxisMask&AxisAbility == 0 {
		in.Dash, in.Shield, in.Interact = old.Dash, old.Shield, old.Interact
	}
	in.AxisMask |= old.AxisMask
	return in
}

func setAxes(dst *ArbitratedInput, src ArbitratedInput, mask AxisMask) {
	if mask&AxisMove != 0 {
		dst.Move = src.Move
	}
	if mask&AxisAim != 0 {
		dst.Aim = src.Aim
	}
	if mask&AxisFire != 0 {
		dst.Fire = src.Fire
	}
	if mask&AxisAbility != 0 {
		dst.Dash, dst.Shield, dst.Interact = src.Dash, src.Shield, src.Interact
	}
}

func (c *ControlState) resolve() ArbitratedInput {
	out := ArbitratedInput{MoveSrc: '-', TurretSrc: '-', FireSrc: '-', AbilitySrc: '-'}
	if c.Assist {
		setAxes(&out, c.Script, c.ScriptAxes)
		// 同 tick 的轴来源细分：Snippet 产生的轴标记 'N'，其余玩家源码 'S'。
		// 两者同层（同一运行时组合执行），人类轴在下方无条件覆盖——仍最高优先。
		if c.ScriptAxes&AxisMove != 0 {
			out.MoveSrc = 'S'
			if c.SnippetAxes&AxisMove != 0 {
				out.MoveSrc = 'N'
			}
		}
		if c.ScriptAxes&AxisAim != 0 {
			out.TurretSrc = 'S'
			if c.SnippetAxes&AxisAim != 0 {
				out.TurretSrc = 'N'
			}
		}
		if c.ScriptAxes&AxisFire != 0 {
			out.FireSrc = 'S'
			if c.SnippetAxes&AxisFire != 0 {
				out.FireSrc = 'N'
			}
		}
		if c.ScriptAxes&AxisAbility != 0 {
			out.AbilitySrc = 'S'
			if c.SnippetAxes&AxisAbility != 0 {
				out.AbilitySrc = 'N'
			}
		}
	}
	setAxes(&out, c.Human, c.HumanAxes)
	if c.HumanAxes&AxisMove != 0 {
		out.MoveSrc = 'H'
	}
	if c.HumanAxes&AxisAim != 0 {
		out.TurretSrc = 'H'
	}
	if c.HumanAxes&AxisFire != 0 {
		out.FireSrc = 'H'
	}
	if c.HumanAxes&AxisAbility != 0 {
		out.AbilitySrc = 'H'
	}
	if n := out.Move.Len(); n > 1 {
		out.Move = out.Move.Scale(1 / n)
	}
	return out
}

func (c *ControlState) acceptScript(in *ScriptCommands) AxisMask {
	var mask AxisMask
	if in.Move != nil {
		c.Script.Move = *in.Move
		mask |= AxisMove
	}
	if in.Aim != nil {
		c.Script.Aim = *in.Aim
		mask |= AxisAim
	}
	if in.Fire != nil {
		c.Script.Fire = *in.Fire
		mask |= AxisFire
	}
	if in.Dash != nil {
		c.Script.Dash = *in.Dash
		mask |= AxisAbility
	}
	if in.Shield != nil {
		c.Script.Shield = *in.Shield
		mask |= AxisAbility
	}
	if in.Interact != nil {
		c.Script.Interact = *in.Interact
		mask |= AxisAbility
	}
	c.ScriptAxes |= mask
	// 分轴归因：本 tick 真正生效的 Snippet 轴 = 组合意图中的 Snippet 轴
	// 与实际写入轴的交集（玩家源码后执行可覆盖同轴值，但归因以最终写入者
	// 为准——组合器保证“玩家源码优先”，被覆盖的轴不记 N）。
	c.SnippetAxes |= in.SnippetAxes & mask
	return mask
}

func (s *Sim) consumeInputs() {
	for i := range s.robots {
		r := &s.robots[i]
		c := &r.Control
		if c.ScriptPending || c.ToggleCount != 0 || r.RespawnPending || c.PendingSay != "" {
			s.controlEvents = append(s.controlEvents, controlRecord{r.ID, ControlRecord{Script: cloneCommands(c.PendingScript), ScriptFailed: c.ScriptFailed, Toggles: c.ToggleCount, Respawn: r.RespawnPending, Say: c.PendingSay}})
		}
		// Log even an input discarded by a same-tick respawn: its sequence guard
		// has already advanced and must be reproducible from the replay stream.
		if r.InputPending {
			r.ConsumedSeq = r.PendingInput.Seq
			s.consumed = append(s.consumed, consumedInput{r.ID, r.PendingInput})
		}
		if r.RespawnPending || (r.State == Dead && r.Combat.RespawnAt != 0 && s.tick >= r.Combat.RespawnAt) {
			s.respawnRobot(r)
		}
		if r.InputPending {
			r.Input, r.PendingInput, r.InputPending = r.PendingInput, Input{}, false
			if r.State != Dead {
				c.HumanAxes |= r.Input.AxisMask
				setAxes(&c.Human, ArbitratedInput{Move: Vec2{float64(r.Input.MoveX) / 1000, float64(r.Input.MoveY) / 1000}, Aim: r.Input.Aim, Fire: r.Input.Fire, Dash: r.Input.Dash, Shield: r.Input.Shield, Interact: r.Input.Interact}, r.Input.AxisMask)
				s.operated(r, r.Input.AxisMask != 0)
			}
		}
		if r.State == Dead {
			r.Control = ControlState{Assist: c.Assist}
			r.Input = Input{}
			continue
		}
		// Toggle precedes arbitration; same-tick human input must still win.
		if c.ToggleCount != 0 {
			// Space 三分支（ADR-0009 分轴仲裁，事件可合并）：
			//  1. assist 关 → 开启并清除人工接管；
			//  2. assist 开且任一轴被人工接管 → 仅把被接管轴交回脚本（assist 保持开）；
			//  3. assist 开且全部脚本控制 → 关闭。
			// 同 tick 先合并真实人类输入，再按分支决定接管轴是否归还。客户端
			// Space 边沿会同步清理本地 held/mask，后续新按键仍可重新接管。
			for i := uint32(0); i < c.ToggleCount; i++ {
				if !c.Assist {
					c.Assist = true
					c.HumanAxes = 0
					c.Human = ArbitratedInput{}
				} else if c.HumanAxes != 0 {
					c.HumanAxes = 0
					c.Human = ArbitratedInput{}
				} else {
					c.Assist = false
					c.Script, c.ScriptAxes = ArbitratedInput{}, 0
				}
			}
			if !c.Assist {
				c.Script, c.ScriptAxes = ArbitratedInput{}, 0
			}
			s.operated(r, true)
		}
		if c.PendingSay != "" {
			s.operated(r, s.say(r, c.PendingSay))
			c.PendingSay = ""
		}
		// Version 2 scripts submit a complete intent each tick. A missing,
		// empty, failed, or timed-out result is neutral; physical Heading remains
		// stateful. Version 0/1 checkpoints retain the historical latch semantics.
		if s.simulationVersion >= 2 {
			c.Script, c.ScriptAxes = ArbitratedInput{}, 0
			c.SnippetAxes = 0
		}
		if c.ScriptPending {
			if c.ScriptFailed {
				c.Script, c.ScriptAxes = ArbitratedInput{}, 0
			} else if c.Assist && c.PendingScript != nil {
				cmd := c.PendingScript
				mask := c.acceptScript(cmd)
				said := cmd.Say != nil && s.say(r, *cmd.Say)
				s.operated(r, mask&^c.HumanAxes != 0 || said || (cmd.PulseScan && c.HumanAxes&AxisAbility == 0))
				if cmd.PulseScan && c.HumanAxes&AxisAbility == 0 {
					r.Combat.PulseRequested = true
				}
			}
		}
		c.ToggleCount, c.PendingScript, c.ScriptPending, c.ScriptFailed = 0, nil, false, false
		c.Output = c.resolve()
		if c.Output.TurretSrc != '-' {
			r.Heading = c.Output.Aim
		}
		if c.Output.Fire || c.Output.Interact {
			r.Combat.Invulnerable, r.Combat.InvulnUntil = false, 0
		}
		if r.Combat.InvulnUntil != 0 && s.tick >= r.Combat.InvulnUntil {
			r.Combat.Invulnerable, r.Combat.InvulnUntil = false, 0
		}
		// Snippet 真实使用埋点（OLD_SCHOOL 门）：本 tick 最终输出中某轴
		// 来源为 N 才计——仅配置未启用轴不计。边沿触发 + 每 robot 节流
		//（同 WallHit 的 0.5s 粒度），事件流与回放确定性不受影响。
		if out := c.Output; out.MoveSrc == 'N' || out.TurretSrc == 'N' || out.FireSrc == 'N' || out.AbilitySrc == 'N' {
			if !r.HasSnippetUse || s.tick-r.LastSnippetUseTick >= WallHitInterval {
				r.LastSnippetUseTick, r.HasSnippetUse = s.tick, true
				axes := uint32(0)
				if out.MoveSrc == 'N' {
					axes |= uint32(AxisMove)
				}
				if out.TurretSrc == 'N' {
					axes |= uint32(AxisAim)
				}
				if out.FireSrc == 'N' {
					axes |= uint32(AxisFire)
				}
				if out.AbilitySrc == 'N' {
					axes |= uint32(AxisAbility)
				}
				s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_SnippetUsage{SnippetUsage: &ombv1.EvSnippetUsage{Robot: r.ID, Axes: axes}}})
			}
		}
	}
}

func (s *Sim) operated(r *Robot, active bool) {
	if active && r.Combat.Invulnerable && r.Combat.InvulnUntil == 0 {
		r.Combat.InvulnUntil = s.tick + InvulnDuration
	}
}
