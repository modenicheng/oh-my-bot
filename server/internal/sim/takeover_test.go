package sim

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 细粒度人工接管（ADR-0009 分轴仲裁）。Space 三分支语义：
//  1. assist 关 → 开启并清除人工接管；
//  2. assist 开且任一轴被人工接管 → 仅把被接管轴交回脚本（assist 保持开）；
//  3. assist 开且全部脚本控制 → 关闭。
// toggle 前同 tick 的真实人类输入仍然优先（接管在同 tick 生效）。

func stepAndArbitrate(t *testing.T, s *Sim, id uint32) ArbitratedInput {
	t.Helper()
	s.Tick()
	return s.Arbitrated(id)
}

// sendInput 以指定 axis_mask 发送一帧客户端输入；返回是否被接受。
func sendInput(t *testing.T, s *Sim, id uint32, mask AxisMask, seq uint32, mutate func(*ombv1.ClientInput)) bool {
	t.Helper()
	in := &ombv1.ClientInput{Seq: seq, AxisMask: uint32(mask)}
	if mutate != nil {
		mutate(in)
	}
	return s.ApplyInput(id, in)
}

// robotControl 读取 robot 的控制状态快照。
func robotControl(t *testing.T, s *Sim, id uint32) ControlState {
	t.Helper()
	r, ok := s.Robot(id)
	if !ok {
		t.Fatalf("robot %d not found", id)
	}
	return r.Control
}

// scriptAll 让 robot 1 拥有全轴脚本命令（开辅助后各轴来源应为 S）。
func scriptAll(t *testing.T, s *Sim) {
	t.Helper()
	mk := func(f float64) *float64 { return &f }
	bp := func(b bool) *bool { return &b }
	ok := s.ApplyScriptCommands(1, ScriptCommands{
		Move:     &Vec2{X: 0, Y: 1},
		Aim:      mk(1.0),
		Fire:     bp(true),
		Shield:   bp(true),
		Interact: bp(false),
		Dash:     bp(false),
	})
	if !ok {
		t.Fatal("ApplyScriptCommands failed")
	}
}

func TestTakeoverBranchAssistOffToOnClearsManualAxes(t *testing.T) {
	s, _ := enemySim(t)

	// 关辅助状态下人工接管 move 轴（接管不因关辅助而丢失）。
	sendInput(t, s, 1, AxisMove, 1, func(in *ombv1.ClientInput) { in.MoveX = 1000 })
	stepAndArbitrate(t, s, 1)
	if c := s.Arbitrated(1); c.MoveSrc != 'H' {
		t.Fatalf("manual takeover with assist off: MoveSrc=%c want H", c.MoveSrc)
	}

	// Space：off→on，开启并清除人工接管；脚本同 tick 供给（agent 持续驱动）。
	s.AssistToggle(1)
	scriptAll(t, s)
	stepAndArbitrate(t, s, 1)

	c := s.Arbitrated(1)
	if c.MoveSrc != 'S' || c.TurretSrc != 'S' {
		t.Fatalf("assist on after toggle with clear: MoveSrc=%c TurretSrc=%c want S,S", c.MoveSrc, c.TurretSrc)
	}
	if !robotControl(t, s, 1).Assist {
		t.Fatal("assist must be on")
	}
}

func TestTakeoverBranchManualAxesReturnToScriptWithoutAssistOff(t *testing.T) {
	s, _ := enemySim(t)
	scriptAll(t, s)

	// 并辅助（分支1），一个 tick 生效。
	s.AssistToggle(1)
	stepAndArbitrate(t, s, 1)
	if !robotControl(t, s, 1).Assist {
		t.Fatal("assist must be on")
	}

	// 接管 move+fire 两轴（真实新 keydown，下一 tick 生效）。
	sendInput(t, s, 1, AxisMove|AxisFire, 1, func(in *ombv1.ClientInput) { in.MoveX = 1000; in.Fire = true })
	scriptAll(t, s)
	stepAndArbitrate(t, s, 1)

	c := s.Arbitrated(1)
	if c.MoveSrc != 'H' || c.TurretSrc != 'S' {
		t.Fatalf("after takeover: MoveSrc=%c TurretSrc=%c want H,S", c.MoveSrc, c.TurretSrc)
	}

	// Space 一次：把人工轴交回脚本，辅助保持开（不经过关闭）。
	s.AssistToggle(1)
	scriptAll(t, s)
	stepAndArbitrate(t, s, 1)

	c = s.Arbitrated(1)
	if c.MoveSrc != 'S' || c.TurretSrc != 'S' {
		t.Fatalf("after single-Space restore: MoveSrc=%c TurretSrc=%c want S,S", c.MoveSrc, c.TurretSrc)
	}
	if !robotControl(t, s, 1).Assist {
		t.Fatal("assist must stay on during single-Space restore")
	}
}

func TestTakeoverBranchAllScriptTurnsAssistOff(t *testing.T) {
	s, _ := enemySim(t)
	scriptAll(t, s)

	s.AssistToggle(1) // off→on
	stepAndArbitrate(t, s, 1)
	s.AssistToggle(1) // on + 全脚本 → off
	stepAndArbitrate(t, s, 1)

	c := s.Arbitrated(1)
	if c.MoveSrc != '-' || c.TurretSrc != '-' {
		t.Fatalf("assist off: MoveSrc=%c TurretSrc=%c want -,-", c.MoveSrc, c.TurretSrc)
	}
	if robotControl(t, s, 1).Assist {
		t.Fatal("assist must be off after second Space with all-script control")
	}
}

// 人工接管必须由真实新输入触发；恢复后的零值帧（keyup 释放帧）不得重新抢占。
// 服务端契约：带 mask 的帧 = 接管该轴（真实新 keydown 可抢，ADR-0009）；
// mask=0 或零值帧不改变 HumanAxes。held 键免疫由客户端边沿触发（toggleAssist
// 清 sticky 与按键状态）+ 同 tick 顺序（输入先合并、toggle 后清除）共同保证。
func TestTakeoverKeyUpZeroInputDoesNotReTakeover(t *testing.T) {
	s, _ := enemySim(t)
	scriptAll(t, s)

	// 分 tick 时序（真实网络：每事件至少隔一拍）。
	s.AssistToggle(1) // off→on
	stepAndArbitrate(t, s, 1)
	sendInput(t, s, 1, AxisMove, 1, func(in *ombv1.ClientInput) { in.MoveX = 1000 })
	stepAndArbitrate(t, s, 1) // move 被人工接管
	if c := s.Arbitrated(1); c.MoveSrc != 'H' {
		t.Fatalf("setup: MoveSrc=%c want H", c.MoveSrc)
	}

	// Space 恢复（一次交回脚本）。
	s.AssistToggle(1)
	scriptAll(t, s)
	stepAndArbitrate(t, s, 1)

	// 恢复后客户端已清 sticky：keyup 释放帧 mask=0，不得重新抢占也不得卡住。
	sendInput(t, s, 1, 0, 2, nil)
	scriptAll(t, s)
	stepAndArbitrate(t, s, 1)
	if c := s.Arbitrated(1); c.MoveSrc != 'S' {
		t.Fatalf("release frame after restore must not re-takeover: MoveSrc=%c want S", c.MoveSrc)
	}

	// 真实新的 keydown（新按键）可再次接管。
	sendInput(t, s, 1, AxisMove, 3, func(in *ombv1.ClientInput) { in.MoveX = -1000 })
	stepAndArbitrate(t, s, 1)
	if c := s.Arbitrated(1); c.MoveSrc != 'H' {
		t.Fatalf("new keydown must take over: MoveSrc=%c want H", c.MoveSrc)
	}

	// 0 输出也是真实接管：接管后松键（帧仍带 mask、值为 0）轴保持人工、输出为零。
	sendInput(t, s, 1, AxisMove, 4, func(in *ombv1.ClientInput) { in.MoveX = 0 })
	stepAndArbitrate(t, s, 1)
	if c := s.Arbitrated(1); c.MoveSrc != 'H' || c.Move.X != 0 || c.Move.Y != 0 {
		t.Fatalf("zero-output takeover: MoveSrc=%c Move=(%v,%v) want H,(0,0)", c.MoveSrc, c.Move.X, c.Move.Y)
	}
}

// 每轴独立：接管 fire 轴不影响 move/aim 的脚本控制。
func TestTakeoverPerAxisIndependence(t *testing.T) {
	s, _ := enemySim(t)
	scriptAll(t, s)

	s.AssistToggle(1)
	stepAndArbitrate(t, s, 1) // 辅助开、脚本接管
	sendInput(t, s, 1, AxisFire, 1, func(in *ombv1.ClientInput) { in.Fire = true })
	scriptAll(t, s)
	stepAndArbitrate(t, s, 1)

	c := s.Arbitrated(1)
	if c.MoveSrc != 'S' || c.TurretSrc != 'S' {
		t.Fatalf("fire takeover must not affect other axes: MoveSrc=%c TurretSrc=%c want S,S", c.MoveSrc, c.TurretSrc)
	}
	if robotControl(t, s, 1).HumanAxes != AxisFire {
		t.Fatalf("fire takeover must not leak to other axes: HumanAxes=%v", robotControl(t, s, 1).HumanAxes)
	}
}

// 恢复时仍按着键：Space 交回后，客户端后续帧（已清 sticky，mask=0）不得重新抢占。
// toggle 与输入分属不同 tick（真实网络时序：接管帧至少流动一 tick 后玩家才可能按 Space）。
func TestTakeoverRestoreImmuneToSameTickInFlightFrame(t *testing.T) {
	s, _ := enemySim(t)
	scriptAll(t, s)

	s.AssistToggle(1)
	stepAndArbitrate(t, s, 1) // 辅助开
	sendInput(t, s, 1, AxisMove, 1, func(in *ombv1.ClientInput) { in.MoveX = 1000 })
	stepAndArbitrate(t, s, 1) // move 被人工接管

	// Space 交回；随后客户端帧已清 sticky（mask=0）。
	s.AssistToggle(1)
	sendInput(t, s, 1, 0, 2, nil) // 恢复后的干净帧
	for i := 0; i < 5; i++ {
		scriptAll(t, s)
		stepAndArbitrate(t, s, 1)
		if c := s.Arbitrated(1); c.MoveSrc != 'S' {
			t.Fatalf("frame %d after restore re-took axis: MoveSrc=%c want S", i, c.MoveSrc)
		}
	}
}
