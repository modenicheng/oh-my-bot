package sim

import "math"

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

// ApplyScriptCommands queues a detached worker result. nil members preserve
// the last script value; explicit false/zero updates that member.
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

// ClearScriptAxes must be called for a failed/timed-out script result; human
// overrides are retained. A missed deadline may use an empty ScriptCommands.
func (s *Sim) ClearScriptAxes(id uint32) bool {
	i, ok := s.index[id]
	if !ok || s.ended {
		return false
	}
	c := &s.robots[i].Control
	c.PendingScript, c.ScriptPending, c.ScriptFailed = nil, true, true
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
		if c.ScriptAxes&AxisMove != 0 {
			out.MoveSrc = 'S'
		}
		if c.ScriptAxes&AxisAim != 0 {
			out.TurretSrc = 'S'
		}
		if c.ScriptAxes&AxisFire != 0 {
			out.FireSrc = 'S'
		}
		if c.ScriptAxes&AxisAbility != 0 {
			out.AbilitySrc = 'S'
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
			humanThisTick := AxisMask(0)
			if len(s.consumed) > 0 && s.consumed[len(s.consumed)-1].robotID == r.ID {
				humanThisTick = r.Input.AxisMask
			}
			// Space 三分支（ADR-0009 分轴仲裁，事件可合并）：
			//  1. assist 关 → 开启并清除人工接管；
			//  2. assist 开且任一轴被人工接管 → 仅把被接管轴交回脚本（assist 保持开）；
			//  3. assist 开且全部脚本控制 → 关闭。
			// 同 tick 在途真实人类输入先合并（上面的 setAxes），随后在此按新状态处理，
			// 仍优先于脚本仲裁；后续每帧输入是否重新抢占由客户端边沿触发约束（恢复时
			// 清 sticky 与按键状态）与输入 mask 语义（0=不接管，带轴=接管）共同保证。
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
			// 同 tick 真实人类输入仍优先：开启/恢复后同帧新接管保留。
			c.HumanAxes |= humanThisTick
			if humanThisTick != 0 {
				setAxes(&c.Human, ArbitratedInput{Move: Vec2{float64(r.Input.MoveX) / 1000, float64(r.Input.MoveY) / 1000}, Aim: r.Input.Aim, Fire: r.Input.Fire, Dash: r.Input.Dash, Shield: r.Input.Shield, Interact: r.Input.Interact}, humanThisTick)
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
	}
}

func (s *Sim) operated(r *Robot, active bool) {
	if active && r.Combat.Invulnerable && r.Combat.InvulnUntil == 0 {
		r.Combat.InvulnUntil = s.tick + InvulnDuration
	}
}
