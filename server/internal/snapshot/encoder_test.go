package snapshot

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func robotIDs(d *ombv1.SnapshotDelta) []uint32 {
	out := make([]uint32, 0, len(d.Robots))
	for _, r := range d.Robots {
		out = append(out, r.Base.Id)
	}
	return out
}

func robotByID(d *ombv1.SnapshotDelta, id uint32) *ombv1.RobotState {
	for _, r := range d.Robots {
		if r.Base.Id == id {
			return r
		}
	}
	return nil
}

func obsOf(w World, observer, partner uint32, ix *WallIndex) sim.Observation {
	return BuildObservation(w, ix, observer, partner)
}

func selfIn(id uint32) *SelfInput {
	r := mkRobot(id, 0, 0)
	return &SelfInput{Robot: r, MoveSrc: 'H', TurretSrc: 'S', AiRounds: 5, AiTokensK: 120}
}

// ---- 首帧 full / base_tick 链 ----

func TestFirstFrameFull(t *testing.T) {
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	w.HealthPacks = []sim.HealthPackView{{ID: 7, Pos: sim.Vec2{X: 3, Y: 4}, Available: false, RespawnInS: 12}}
	enc := NewEncoder()
	d1 := enc.Encode(100, 5, sim.PhaseOuterRing, 480, obsOf(w, 1, 2, nil), selfIn(1))
	if !d1.Full {
		t.Fatal("首帧必须 full=true")
	}
	if d1.BaseTick != 0 {
		t.Fatalf("首帧 base_tick=0，got %d", d1.BaseTick)
	}
	if d1.Tick != 100 || d1.AckSeq != 5 || d1.TimeLeftS != 480 {
		t.Fatalf("标头字段回传错误：%+v", d1)
	}
	// full 携带元数据。
	r2 := robotByID(d1, 2)
	//nolint:staticcheck // IsPartner 已弃用：断言编码器不再置位（legacy replay 兼容）
	if r2 == nil || r2.Nick != "r" || r2.Color != "#fff" || r2.IsPartner {
		t.Fatalf("full 应含元数据与 partner 标记：%+v", r2)
	}
	if d1.Self == nil || d1.Self.RobotId != 1 || d1.Self.MoveSrc != ombv1.ControlSource_CS_HUMAN {
		t.Fatalf("Self 编码错误：%+v", d1.Self)
	}
	if len(d1.HealthPacks) != 1 || d1.HealthPacks[0].Base.Id != 7 || d1.HealthPacks[0].Available || d1.HealthPacks[0].RespawnInS != 12 {
		t.Fatalf("full health pack state missing: %+v", d1.HealthPacks)
	}

	// 第二帧：无变化 → delta 空。
	d2 := enc.Encode(101, 6, sim.PhaseOuterRing, 479, obsOf(w, 1, 2, nil), selfIn(1))
	if d2.Full {
		t.Fatal("第二帧不应 full")
	}
	if d2.BaseTick != 100 {
		t.Fatalf("base_tick 应为上一帧 100，got %d", d2.BaseTick)
	}
	if len(d2.Robots) != 0 || len(d2.RobotGone) != 0 {
		t.Fatalf("无变化帧应全空：robots=%v gone=%v", d2.Robots, d2.RobotGone)
	}
	if len(d2.HealthPacks) != 1 || d2.HealthPacks[0].RespawnInS != 12 {
		t.Fatalf("delta must carry full health pack state: %+v", d2.HealthPacks)
	}

	// 第三帧 base_tick 链到 101。
	w3 := w
	w3.Tick = 102
	d3 := enc.Encode(102, 6, sim.PhaseOuterRing, 478, obsOf(w3, 1, 2, nil), selfIn(1))
	if d3.BaseTick != 101 {
		t.Fatalf("base_tick 链断裂：got %d", d3.BaseTick)
	}
}

// ---- delta 变化检测 ----

func TestDeltaChangeDetection(t *testing.T) {
	base := []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)}
	enc := NewEncoder()
	w := mkWorld(nil, base)
	enc.Encode(1, 0, sim.PhaseOuterRing, 480, obsOf(w, 1, 2, nil), selfIn(1))

	// HP 变化（位置不变）。
	chg := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	chg.Robots[1].HpX10 = 880
	d := enc.Encode(2, 0, sim.PhaseOuterRing, 479, obsOf(chg, 1, 2, nil), selfIn(1))
	if got := robotIDs(d); len(got) != 1 || got[0] != 2 {
		t.Fatalf("HP 变化应只重发 2 号：got %v", got)
	}
	if robotByID(d, 2).HpX10 != 880 {
		t.Fatal("变化值未携带")
	}
	// 变化帧不带元数据（delta 语义）。
	if robotByID(d, 2).Nick != "" {
		t.Fatal("delta 帧不应携带 nick")
	}

	// 能量变化。
	chg2 := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	chg2.Robots[1].EnergyX10 = 500
	d = enc.Encode(3, 0, sim.PhaseOuterRing, 478, obsOf(chg2, 1, 2, nil), selfIn(1))
	if got := robotIDs(d); len(got) != 1 || got[0] != 2 {
		t.Fatalf("能量变化应只重发 2 号：got %v", got)
	}

	// 无变化 → 空。
	d = enc.Encode(4, 0, sim.PhaseOuterRing, 477, obsOf(chg2, 1, 2, nil), selfIn(1))
	if len(d.Robots) != 0 {
		t.Fatalf("无变化帧应空：got %v", robotIDs(d))
	}

	// 原地转炮塔必须立即下发，不能等移动或耗能后才更新瞄准线。
	chg4 := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	chg4.Robots[1].EnergyX10 = 500
	chg4.Robots[1].Turret = 1.5
	d = enc.Encode(5, 0, sim.PhaseOuterRing, 476, obsOf(chg4, 1, 2, nil), selfIn(1))
	if r := robotByID(d, 2); r == nil || r.Base.Heading != 1.5 {
		t.Fatalf("纯 turret 变化必须下发：got %v", d.Robots)
	}
	// 技能的结束帧也必须下发，即使能量已回满。
	chg4.Robots[1].ShieldOn = true
	d = enc.Encode(6, 0, sim.PhaseOuterRing, 476, obsOf(chg4, 1, 2, nil), selfIn(1))
	if r := robotByID(d, 2); r == nil || !r.ShieldOn {
		t.Fatal("shield start missing")
	}
	chg4.Robots[1].ShieldOn = false
	chg4.Robots[1].Dashing = true
	d = enc.Encode(7, 0, sim.PhaseOuterRing, 476, obsOf(chg4, 1, 2, nil), selfIn(1))
	if r := robotByID(d, 2); r == nil || r.ShieldOn || !r.Dashing {
		t.Fatal("ability transition missing")
	}
	chg4.Robots[1].Dashing = false
	d = enc.Encode(8, 0, sim.PhaseOuterRing, 476, obsOf(chg4, 1, 2, nil), selfIn(1))
	if r := robotByID(d, 2); r == nil || r.Dashing {
		t.Fatal("dash end missing")
	}
}

// Private state is sent on every snapshot, including reconnect/full while a CD is active.
func TestPrivateSkillStateSurvivesFullResync(t *testing.T) {
	enc := NewEncoder()
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	self := selfIn(1)
	self.DashReadyTick, self.FireReadyTick = 250, 115
	first := enc.Encode(100, 0, sim.PhaseOuterRing, 479, obsOf(w, 1, 0, nil), self)
	if first.Self.AssistOn == nil || first.Self.GetAssistOn() || first.Self.GetDashReadyTick() != 250 || first.Self.GetFireReadyTick() != 115 {
		t.Fatalf("missing authoritative initial state: %v", first.Self)
	}
	self.AssistOn = true
	enc.ForceFull()
	next := enc.Encode(120, 0, sim.PhaseOuterRing, 478, obsOf(w, 1, 0, nil), self)
	if !next.Full || !next.Self.GetAssistOn() || next.Self.GetDashReadyTick() != 250 {
		t.Fatalf("resync must preserve private state: %v", next.Self)
	}
	// Retained frames do not alias caller state.
	if first.Self.GetAssistOn() {
		t.Fatal("old frame changed after caller mutation")
	}
}

// ---- tombstone 生命周期：进入-离开-再进入 ----

func TestTombstoneLifecycle(t *testing.T) {
	enc := NewEncoder()
	walls := []sim.Wall{mkWall(1, 4, -10, 5, 10)}

	// tick1：1 与 2 同视野（full）。墙对同侧无遮挡，直接用无墙世界。
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	enc.Encode(1, 0, sim.PhaseOuterRing, 480, obsOf(w, 1, 0, nil), selfIn(1))

	// tick2：2 移出视野（35m）→ tombstone。
	wOut := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 35, 0)})
	d2 := enc.Encode(2, 0, sim.PhaseOuterRing, 479, obsOf(wOut, 1, 0, nil), selfIn(1))
	if len(d2.RobotGone) != 1 || d2.RobotGone[0] != 2 {
		t.Fatalf("离开 AOI 应产生 tombstone：got %v", d2.RobotGone)
	}

	// tick3：持续在外 → 不再重复 tombstone。
	d3 := enc.Encode(3, 0, sim.PhaseOuterRing, 478, obsOf(wOut, 1, 0, nil), selfIn(1))
	if len(d3.RobotGone) != 0 {
		t.Fatalf("持续离开不应重复 tombstone：got %v", d3.RobotGone)
	}

	// tick4：再进入（12m）→ 完整元数据 + 无 tombstone。
	wIn := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 12, 0)})
	d4 := enc.Encode(4, 0, sim.PhaseOuterRing, 477, obsOf(wIn, 1, 0, nil), selfIn(1))
	r2 := robotByID(d4, 2)
	if r2 == nil {
		t.Fatal("再进入应出现在 delta")
	}
	if r2.Nick == "" || r2.Color == "" {
		t.Fatal("再进入应携带完整元数据")
	}
	if len(d4.RobotGone) != 0 {
		t.Fatal("再进入帧不应有 tombstone")
	}

	// tick5：再次离开 → 再次 tombstone（生命周期闭环）。
	d5 := enc.Encode(5, 0, sim.PhaseOuterRing, 476, obsOf(wOut, 1, 0, nil), selfIn(1))
	if len(d5.RobotGone) != 1 || d5.RobotGone[0] != 2 {
		t.Fatalf("再次离开应再次 tombstone：got %v", d5.RobotGone)
	}
	_ = walls
}

// ---- ForceFull ----

func TestForceFull(t *testing.T) {
	enc := NewEncoder()
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0), mkRobot(2, 10, 0)})
	enc.Encode(10, 0, sim.PhaseOuterRing, 480, obsOf(w, 1, 2, nil), selfIn(1))
	d := enc.Encode(11, 0, sim.PhaseOuterRing, 479, obsOf(w, 1, 2, nil), selfIn(1))
	if d.Full {
		t.Fatal("未触发时应为 delta")
	}

	enc.ForceFull() // 模拟 ResyncRequest
	d = enc.Encode(12, 0, sim.PhaseOuterRing, 478, obsOf(w, 1, 2, nil), selfIn(1))
	if !d.Full {
		t.Fatal("ForceFull 后必须 full")
	}
	if d.BaseTick != 11 {
		t.Fatalf("full 帧 base_tick 仍指上一帧：got %d", d.BaseTick)
	}
	r2 := robotByID(d, 2)
	if r2 == nil || r2.Nick == "" {
		t.Fatal("重同步 full 应带元数据")
	}
	// full 之后恢复正常 delta。
	d = enc.Encode(13, 0, sim.PhaseOuterRing, 477, obsOf(w, 1, 2, nil), selfIn(1))
	if d.Full || len(d.Robots) != 0 {
		t.Fatalf("full 后应恢复空 delta：full=%v robots=%v", d.Full, robotIDs(d))
	}
}

// ---- Core/Uplink 编码 ----

func TestCoreAndUplinkEncoding(t *testing.T) {
	enc := NewEncoder()
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	w.Cores = []sim.CoreView{{ID: 10, Pos: sim.Vec2{X: 1, Y: 1}, Value: 10, Alive: true}}
	w.Uplinks = []sim.UplinkView{{ID: 20, Pos: sim.Vec2{X: 2, Y: 2}, Active: true, PersonalCDs: map[uint32]uint32{1: 30}}}
	d1 := enc.Encode(1, 0, sim.PhaseOuterRing, 480, obsOf(w, 1, 0, nil), selfIn(1))
	if len(d1.Cores) != 1 || d1.Cores[0].Value != 10 {
		t.Fatalf("Core 编码错误：%+v", d1.Cores)
	}
	if len(d1.Uplinks) != 1 {
		t.Fatalf("Uplink 编码错误：%d", len(d1.Uplinks))
	}
	u := d1.Uplinks[0]
	if u.MyCooldownS != 30 {
		t.Fatalf("my_cooldown_s 应取 PersonalCDs[observer]：got %d", u.MyCooldownS)
	}
	if u.Ready {
		t.Fatal("CD 中不应 Ready")
	}

	// Core 被拾取 → core_gone；Uplink CD 归零 → 变化重发 + Ready。
	w2 := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	w2.Uplinks = []sim.UplinkView{{ID: 20, Pos: sim.Vec2{X: 2, Y: 2}, Active: true, PersonalCDs: map[uint32]uint32{1: 0}}}
	d2 := enc.Encode(2, 0, sim.PhaseOuterRing, 479, obsOf(w2, 1, 0, nil), selfIn(1))
	if len(d2.CoreGone) != 1 || d2.CoreGone[0] != 10 {
		t.Fatalf("Core 消失应以 core_gone 表达：got %v", d2.CoreGone)
	}
	if len(d2.Uplinks) != 1 || !d2.Uplinks[0].Ready {
		t.Fatalf("Uplink CD 归零应重发且 Ready：got %+v", d2.Uplinks)
	}

	// Uplink 引导进度变化触发重发（progress 0→1.5s）。
	w3 := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	w3.Uplinks = []sim.UplinkView{{ID: 20, Pos: sim.Vec2{X: 2, Y: 2}, Active: true, HackingID: 3, ProgressS: 1.5, PersonalCDs: map[uint32]uint32{1: 0}}}
	d3 := enc.Encode(3, 0, sim.PhaseOuterRing, 478, obsOf(w3, 1, 0, nil), selfIn(1))
	if len(d3.Uplinks) != 1 || d3.Uplinks[0].ProgressX10 != 15 || d3.Uplinks[0].HackingId != 3 {
		t.Fatalf("引导进度应触发重发：%+v", d3.Uplinks)
	}
}

// ---- Projectile 编码与 tombstone ----

func TestProjectileEncoding(t *testing.T) {
	enc := NewEncoder()
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	w.Projectiles = []sim.ProjView{{ID: 30, Owner: 2, Pos: sim.Vec2{X: 5, Y: 5}, Heading: 0.5}}
	d1 := enc.Encode(1, 0, sim.PhaseOuterRing, 480, obsOf(w, 1, 0, nil), selfIn(1))
	if len(d1.Projectiles) != 1 || d1.Projectiles[0].OwnerId != 2 {
		t.Fatalf("Projectile full 编码错误：%+v", d1.Projectiles)
	}
	// 弹丸移动 → 重发。
	w.Projectiles[0].Pos = sim.Vec2{X: 5.5, Y: 5.5}
	d2 := enc.Encode(2, 0, sim.PhaseOuterRing, 479, obsOf(w, 1, 0, nil), selfIn(1))
	if len(d2.Projectiles) != 1 {
		t.Fatal("弹丸位移应重发")
	}
	// 弹丸消失 → projectile_gone。
	w.Projectiles = nil
	d3 := enc.Encode(3, 0, sim.PhaseOuterRing, 478, obsOf(w, 1, 0, nil), selfIn(1))
	if len(d3.ProjectileGone) != 1 || d3.ProjectileGone[0] != 30 {
		t.Fatalf("弹丸消失应以 projectile_gone 表达：got %v", d3.ProjectileGone)
	}
}

// ---- Phase 编码 ----

func TestPhaseEncoding(t *testing.T) {
	enc := NewEncoder()
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	d1 := enc.Encode(1, 0, sim.PhaseOuterRing, 480, obsOf(w, 1, 0, nil), selfIn(1))
	if d1.Phase != ombv1.Phase_OUTER_RING {
		t.Fatalf("Phase 编码错误：%v", d1.Phase)
	}
	wCore := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	wCore.Phase = sim.PhaseCoreOpen
	d2 := enc.Encode(2, 0, sim.PhaseCoreOpen, 240, obsOf(wCore, 1, 0, nil), selfIn(1))
	if d2.Phase != ombv1.Phase_CORE_OPEN {
		t.Fatalf("Phase 编码错误：%v", d2.Phase)
	}
}

// ---- 无 self 路径 ----

func TestNilSelf(t *testing.T) {
	enc := NewEncoder()
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	d := enc.Encode(1, 0, sim.PhaseOuterRing, 480, obsOf(w, 1, 0, nil), nil)
	if d.Self != nil {
		t.Fatal("self=nil 时 Self 应留空")
	}
}

func TestProjectileColorWithoutVisibleOwner(t *testing.T) {
	enc := NewEncoder()
	obs := sim.Observation{Projectiles: []sim.ProjView{{ID: 10, Owner: 99, Color: "#a78bfa", Pos: sim.Vec2{X: 2}}}}
	full := enc.Encode(1, 0, sim.PhaseOuterRing, 480, obs, nil)
	if len(full.Robots) != 0 || len(full.Projectiles) != 1 || full.Projectiles[0].Color != "#a78bfa" {
		t.Fatalf("full projectile color: %+v", full)
	}
	obs.Projectiles[0].Pos.X++
	delta := enc.Encode(2, 0, sim.PhaseOuterRing, 480, obs, nil)
	if len(delta.Projectiles) != 1 || delta.Projectiles[0].Color != "#a78bfa" {
		t.Fatalf("delta color: %+v", delta)
	}
	obs.Projectiles[0].Color = "#fbbf24"
	delta = enc.Encode(3, 0, sim.PhaseOuterRing, 480, obs, nil)
	if len(delta.Projectiles) != 1 || delta.Projectiles[0].Color != "#fbbf24" {
		t.Fatalf("color-only delta: %+v", delta)
	}
}
