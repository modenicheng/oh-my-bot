package sim

import (
	"bytes"
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 派生值表（docs/plans/upgrade-system.md 数值冻结）：L1–5 满步长、L6–10 半步长。
func TestUpgradeDerivedValues(t *testing.T) {
	s := NewSim(1, []uint32{1}, nil)
	if s.simulationVersion != 5 {
		t.Fatalf("simulation version = %d, want 5", s.simulationVersion)
	}
	cases := []struct {
		level                                              int
		wantHP, wantEnergy, wantSpeed, wantShield, wantAtk float64
	}{
		{0, 100, 100, 8.0, 0.35, 9},
		{1, 120, 125, 8.4, 0.30, 10},
		{5, 200, 225, 10.0, 0.10, 14},
		{6, 210, 240, 10.2, 0.09, 14.5},
		{10, 250, 300, 11.0, 0.05, 16.5},
	}
	for _, c := range cases {
		r := &Robot{Upg: UpgradeState{}}
		for track := 0; track < UpgradeTrackCount; track++ {
			r.Upg.Levels[track] = uint8(c.level)
		}
		if got := s.maxHPOf(r); got != c.wantHP {
			t.Fatalf("L%d maxHP = %v, want %v", c.level, got, c.wantHP)
		}
		if got := s.maxEnergyOf(r); got != c.wantEnergy {
			t.Fatalf("L%d maxEnergy = %v, want %v", c.level, got, c.wantEnergy)
		}
		if got := s.moveSpeedOf(r); got != c.wantSpeed {
			t.Fatalf("L%d moveSpeed = %v, want %v", c.level, got, c.wantSpeed)
		}
		if got := s.shieldScaleOf(r); math.Abs(got-c.wantShield) > 1e-9 {
			t.Fatalf("L%d shieldScale = %v, want %v", c.level, got, c.wantShield)
		}
		if got := s.shotDamageOf(r); got != c.wantAtk {
			t.Fatalf("L%d shotDamage = %v, want %v", c.level, got, c.wantAtk)
		}
	}
	// 零级 = v4 常量严格相等；显式 v4 回放走旧常量（升级轨被忽略）。
	v4 := NewSim(1, []uint32{1}, nil)
	v4.simulationVersion = 4
	r := &Robot{Upg: UpgradeState{Levels: [UpgradeTrackCount]uint8{10, 10, 10, 10, 10}}}
	if got := v4.maxHPOf(r); got != MaxHP || v4.maxEnergyOf(r) != MaxEnergy || v4.moveSpeedOf(r) != MaxSpeed ||
		v4.shieldScaleOf(r) != ShieldDamageScale || v4.shotDamageOf(r) != ShotDamage {
		t.Fatalf("v4 accessor must ignore upgrade levels: %v/%v/%v/%v/%v",
			v4.maxHPOf(r), v4.maxEnergyOf(r), v4.moveSpeedOf(r), v4.shieldScaleOf(r), v4.shotDamageOf(r))
	}
	if v4.BuyUpgrade(1, 1) {
		t.Fatal("v4 sim must reject upgrade purchases")
	}
}

func TestUpgradeCostCurveFrozen(t *testing.T) {
	want := [UpgradeMaxLevel]int32{2, 3, 5, 8, 12, 18, 27, 40, 60, 90}
	if UpgradeCosts != want {
		t.Fatalf("cost curve drifted: %v", UpgradeCosts)
	}
	var total int32
	for _, c := range UpgradeCosts {
		total += c
	}
	if total != 265 {
		t.Fatalf("per-track total = %d, want 265", total)
	}
	if UpgradePointsFor(10) != 5 || UpgradePointsFor(25) != 10 {
		t.Fatalf("core point mapping drifted: %d/%d", UpgradePointsFor(10), UpgradePointsFor(25))
	}
}

func TestBuyUpgradeValidationAndHeal(t *testing.T) {
	s := NewSim(3, []uint32{1, 2}, nil)
	if s.BuyUpgrade(1, 0) || s.BuyUpgrade(1, 6) || s.BuyUpgrade(9, 1) {
		t.Fatal("out-of-range track or unknown robot accepted")
	}
	r := &s.robots[s.index[1]]
	r.Upg.Points = 4 // 仅够 L1（2 点）；L2（3 点）余额不足须静默拒绝
	if !s.BuyUpgrade(1, TrackHP+1) {
		t.Fatal("first purchase rejected")
	}
	r.HP = 50 // 受损状态下买血量轨：顺带回血本次增量（+20）
	s.Tick()
	if r.Upg.Levels[TrackHP] != 1 || r.Upg.Points != 2 {
		t.Fatalf("purchase not applied: %+v", r.Upg)
	}
	if r.HP != 70 {
		t.Fatalf("hp track must heal the step delta: %v", r.HP)
	}
	s.BuyUpgrade(1, TrackHP+1) // L2 需 3 点，余额 2 → 排队后被静默拒绝
	s.Tick()
	if r.Upg.Levels[TrackHP] != 1 || r.Upg.Points != 2 {
		t.Fatalf("insufficient funds must silently reject: %+v", r.Upg)
	}
	// 满级拒绝：直接构造满级 + 足额点数。
	r.Upg.Points = 1000
	for i := range r.Upg.Levels {
		r.Upg.Levels[i] = UpgradeMaxLevel
	}
	s.BuyUpgrade(1, TrackSpeed+1)
	s.Tick()
	if r.Upg.Levels[TrackSpeed] != UpgradeMaxLevel || r.Upg.Points != 1000 {
		t.Fatalf("max level must reject: %+v", r.Upg)
	}
}

func TestBuyWhileDeadAppliesOnRespawn(t *testing.T) {
	s := NewSim(3, []uint32{1}, nil)
	r := &s.robots[s.index[1]]
	r.State, r.Combat.RespawnAt = Dead, s.tick+2
	r.Upg.Points = 2
	if !s.BuyUpgrade(1, TrackHP+1) {
		t.Fatal("dead robot purchase rejected")
	}
	advance(s, s.tick+3) // 越过复活 tick：排队购买跨复活保留并消费
	if r.State != Alive || r.Upg.Levels[TrackHP] != 1 {
		t.Fatalf("dead purchase lost: state=%v upg=%+v", r.State, r.Upg)
	}
	if r.HP != 120 {
		t.Fatalf("respawn must fill to upgraded cap: %v", r.HP)
	}
}

func TestCorePickupAwardsPoints(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(5, []uint32{1}, sink)
	m := gameMap()
	m.CorePads = []CorePadDef{{ID: 100, Pos: Vec2{20, 0}, Value: 10, Group: 0}, {ID: 101, Pos: Vec2{20.5, 0}, Value: 25, Group: 0}}
	m.CoreRules.TargetAlive = 2
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{20, 0}, 0); err != nil {
		t.Fatal(err)
	}
	s.Tick()
	r, _ := s.Robot(1)
	if r.Upg.Points != 15 { // 普通 5 + Mega 10
		t.Fatalf("pickup points = %d, want 15", r.Upg.Points)
	}
	// 计分语义不受影响：事件载荷仍为 core 原值。
	found := false
	for _, ev := range sink.events {
		if p := ev.GetCorePickup(); p != nil && p.By == 1 {
			found = true
			if p.Value != 10 && p.Value != 25 {
				t.Fatalf("core value mutated: %d", p.Value)
			}
		}
	}
	if !found {
		t.Fatal("core pickup event missing")
	}
	// pre-v5 回放：拾取不加点（升级状态保持零值，checkpoint 可复现）。
	old := NewSim(5, []uint32{1}, nil)
	old.simulationVersion = 4
	if err := old.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err := old.SetSpawn(1, Vec2{20, 0}, 0); err != nil {
		t.Fatal(err)
	}
	old.Tick()
	r, _ = old.Robot(1)
	if r.Upg.Points != 0 {
		t.Fatalf("v4 pickup must not award points: %d", r.Upg.Points)
	}
}

// 赏金分支全变体：无赏金 / 情形 A（只掉点数）/ 情形 B（掉级+退款）/
// 平级 tie-break / 满级基准。
func TestBountyPenaltyCases(t *testing.T) {
	spawn := func(levels [UpgradeTrackCount]uint8, points int32) (*Sim, *Robot) {
		s := NewSim(9, []uint32{1, 2}, nil)
		r := &s.robots[s.index[1]]
		r.State = Dead
		r.Position = Vec2{30, 50}
		r.Upg = UpgradeState{Points: points, Levels: levels}
		return s, r
	}
	// 无赏金（全 <4）：点数保留、不掉级、无事件。
	s, r := spawn([UpgradeTrackCount]uint8{3, 3, 3, 3, 3}, 12)
	s.applyBountyPenalty(r)
	if r.Upg.Points != 12 || len(s.pointDrops) != 0 {
		t.Fatalf("sub-bounty death must keep wallet: %+v drops=%d", r.Upg, len(s.pointDrops))
	}
	// 情形 A：hp L4、基准=L5 成本 12、钱包 7 ≥ 6 → 只掉 7，等级不变。
	s, r = spawn([UpgradeTrackCount]uint8{4, 0, 0, 0, 0}, 7)
	s.applyBountyPenalty(r)
	if r.Upg.Points != 0 || r.Upg.Levels[TrackHP] != 4 {
		t.Fatalf("case A must only drop wallet: %+v", r.Upg)
	}
	if total := dropTotal(s.pointDrops); total != 7 {
		t.Fatalf("case A dropped %d, want 7", total)
	}
	// 情形 B：钱包 5 < 6 → 掉 5 + L4 退款 8 = 13，hp→L3。
	s, r = spawn([UpgradeTrackCount]uint8{4, 0, 0, 0, 0}, 5)
	s.applyBountyPenalty(r)
	if r.Upg.Levels[TrackHP] != 3 || r.Upg.Points != 0 {
		t.Fatalf("case B must drop one level: %+v", r.Upg)
	}
	if total := dropTotal(s.pointDrops); total != 13 {
		t.Fatalf("case B dropped %d, want 13", total)
	}
	// 平级 tie-break：hp 与 attack 同为 L4 → 掉 hp（下标小者）。
	s, r = spawn([UpgradeTrackCount]uint8{4, 0, 0, 4, 0}, 5)
	s.applyBountyPenalty(r)
	if r.Upg.Levels[TrackHP] != 3 || r.Upg.Levels[TrackAttack] != 4 {
		t.Fatalf("tie must drop lowest track index: %+v", r.Upg)
	}
	// attack 更高：掉 attack。基准取其 L5 成本。
	s, r = spawn([UpgradeTrackCount]uint8{4, 0, 0, 5, 0}, 5)
	s.applyBountyPenalty(r)
	if r.Upg.Levels[TrackAttack] != 4 || r.Upg.Levels[TrackHP] != 4 {
		t.Fatalf("must drop the top track: %+v", r.Upg)
	}
	// 满级基准：hp L10、钱包 0 → 0 < 90/2 → 掉级退款 90。
	s, r = spawn([UpgradeTrackCount]uint8{UpgradeMaxLevel, 0, 0, 0, 0}, 0)
	s.applyBountyPenalty(r)
	if r.Upg.Levels[TrackHP] != UpgradeMaxLevel-1 {
		t.Fatalf("maxed base must still drop a level: %+v", r.Upg)
	}
	if total := dropTotal(s.pointDrops); total != 90 {
		t.Fatalf("maxed refund = %d, want 90", total)
	}
	// 掉级后血量上限即时收紧（不变式）。
	s, r = spawn([UpgradeTrackCount]uint8{5, 0, 0, 0, 0}, 0)
	r.HP = s.maxHPOf(r)
	s.applyBountyPenalty(r)
	if r.Upg.Levels[TrackHP] != 4 || r.HP > s.maxHPOf(r) {
		t.Fatalf("hp cap must tighten with level loss: %+v hp=%v cap=%v", r.Upg, r.HP, s.maxHPOf(r))
	}
}

func dropTotal(drops []PointDrop) int32 {
	var total int32
	for _, d := range drops {
		total += d.Points
	}
	return total
}

// 晶片：拆分上限、30s 到期、第三方/复活本人拾取、锁区限制。
func TestPointDropLifecycle(t *testing.T) {
	s := NewSim(11, []uint32{1, 2}, nil)
	if err := s.SetMap(gameMap()); err != nil {
		t.Fatal(err)
	}
	victim := &s.robots[s.index[1]]
	victim.State, victim.Position = Dead, Vec2{30, 50}
	victim.Upg = UpgradeState{Points: 7, Levels: [UpgradeTrackCount]uint8{4, 0, 0, 0, 0}}
	s.applyBountyPenalty(victim)
	if n := len(s.pointDrops); n != 1 { // 7+8=15 → k=1
		t.Fatalf("orb count = %d, want 1", n)
	}
	// 大额拆分：64 → k=ceil(64/15)=5 → 钳到 4；余数归末只。
	s.pointDrops = nil
	s.spawnPointDrops(victim.Position, 64)
	if n := len(s.pointDrops); n != PointDropMaxOrbs {
		t.Fatalf("orb split = %d, want %d", n, PointDropMaxOrbs)
	}
	if total := dropTotal(s.pointDrops); total != 64 {
		t.Fatalf("split total = %d, want 64", total)
	}
	for _, d := range s.pointDrops {
		if dist := d.Pos.Sub(victim.Position).Len(); dist > PointDropScatterMax+1e-9 {
			t.Fatalf("orb scattered beyond ring: %v", dist)
		}
	}
	// 第三方拾取：whoever touches first；只加点数不给计分。
	robber := &s.robots[s.index[2]]
	robber.State = Alive
	first := s.pointDrops[0]
	robber.PathStart, robber.Position = first.Pos, first.Pos
	s.stepPointDrops()
	if robber.Upg.Points != first.Points {
		t.Fatalf("robber points = %d, want %d", robber.Upg.Points, first.Points)
	}
	hasPickup := false
	for _, ev := range s.events {
		if p := ev.GetPointDropPickup(); p != nil && p.By == 2 {
			hasPickup = true
			if p.DropId != first.ID || p.Points != first.Points {
				t.Fatalf("pickup event drifted: %+v", p)
			}
		}
		if ev.GetCorePickup() != nil {
			t.Fatal("point drop must not emit core pickup (score pollution)")
		}
	}
	if !hasPickup {
		t.Fatal("pickup event missing")
	}
	// 死亡机器人不能拾取。
	dead := &s.robots[s.index[1]]
	dead.State = Dead
	second := s.pointDrops[0]
	dead.PathStart, dead.Position = second.Pos, second.Pos
	before := dead.Upg.Points
	s.stepPointDrops()
	if dead.Upg.Points != before {
		t.Fatal("dead robot picked up a drop")
	}
	// 到期消失（30s TTL）。
	for i := range s.pointDrops {
		s.pointDrops[i].GoneAt = s.tick + 1
	}
	advance(s, s.tick+2)
	if len(s.pointDrops) != 0 {
		t.Fatalf("expired drops must vanish: %d", len(s.pointDrops))
	}
	// 复活本人可回拾：victim 复活后再经过晶片位置即可拾取（同拾取路径）。
}

func TestUpgradeCheckpointRoundtripAndValidation(t *testing.T) {
	s := NewSim(21, []uint32{1, 2}, nil)
	if err := s.SetMap(gameMap()); err != nil {
		t.Fatal(err)
	}
	r := &s.robots[s.index[1]]
	r.Upg = UpgradeState{Points: 33, Levels: [UpgradeTrackCount]uint8{4, 2, 0, 7, 1}}
	r.HP = s.maxHPOf(r)
	r.State, r.Position = Dead, Vec2{30, 50}
	s.applyBountyPenalty(r)
	cp := s.Snapshot()
	if len(cp.PointDrops) == 0 {
		t.Fatal("expected scattered drops in checkpoint")
	}
	back, err := RestoreCheckpoint(cp, nil)
	if err != nil {
		t.Fatal(err)
	}
	restored, _ := back.Robot(1)
	if !reflect.DeepEqual(restored.Upg, r.Upg) {
		t.Fatalf("upgrade state roundtrip: %+v vs %+v", restored.Upg, r.Upg)
	}
	if !reflect.DeepEqual(back.Snapshot().PointDrops, cp.PointDrops) {
		t.Fatal("point drops roundtrip mismatch")
	}
	// 校验拒绝：越级/负点数/超上限 HP/坏晶片。
	bad := s.Snapshot()
	bad.Robots[s.index[1]].Upg.Levels[TrackHP] = UpgradeMaxLevel + 1
	if _, err := RestoreCheckpoint(bad, nil); err == nil {
		t.Fatal("overleveled checkpoint accepted")
	}
	bad = s.Snapshot()
	bad.Robots[s.index[1]].Upg.Points = -1
	if _, err := RestoreCheckpoint(bad, nil); err == nil {
		t.Fatal("negative points accepted")
	}
	bad = s.Snapshot()
	bad.Robots[s.index[1]].HP = maxHPFor(5, &bad.Robots[s.index[1]].Upg) + 1
	if _, err := RestoreCheckpoint(bad, nil); err == nil {
		t.Fatal("hp above upgraded cap accepted")
	}
	bad = s.Snapshot()
	bad.PointDrops = append([]PointDrop{}, bad.PointDrops...)
	bad.PointDrops[0].GoneAt = bad.Tick
	if _, err := RestoreCheckpoint(bad, nil); err == nil {
		t.Fatal("expired drop accepted")
	}
	bad = s.Snapshot()
	bad.PointDrops = append(bad.PointDrops, PointDrop{ID: 999999, Points: 5, GoneAt: bad.Tick + 60, Pos: Vec2{30, 50}})
	if _, err := RestoreCheckpoint(bad, nil); err == nil {
		t.Fatal("drop beyond next entity id accepted")
	}
}

// 回放确定性全链：拾 core → 购买到赏金状态 → 被击杀 → 散落 → 击杀者拾取晶片。
// 直播与 ReplayTo 重放的终局 checkpoint 必须逐字节一致。
func TestUpgradeReplayDeterminism(t *testing.T) {
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(77, []uint32{1, 2}, log)
	m := gameMap()
	// 十只 25 分 Mega pad 密集排在受害者出生点 0.8m 内（接触半径 0.95m）：
	// 开局补给 10×10 = 100 点。
	m.CorePads = []CorePadDef{
		{ID: 100, Pos: Vec2{20, 0}, Value: 25, Group: 0},
		{ID: 101, Pos: Vec2{20.4, 0}, Value: 25, Group: 0},
		{ID: 102, Pos: Vec2{19.6, 0}, Value: 25, Group: 0},
		{ID: 103, Pos: Vec2{20, 0.4}, Value: 25, Group: 0},
		{ID: 104, Pos: Vec2{20, -0.4}, Value: 25, Group: 0},
		{ID: 105, Pos: Vec2{20.28, 0.28}, Value: 25, Group: 0},
		{ID: 106, Pos: Vec2{20.28, -0.28}, Value: 25, Group: 0},
		{ID: 107, Pos: Vec2{19.72, 0.28}, Value: 25, Group: 0},
		{ID: 108, Pos: Vec2{19.72, -0.28}, Value: 25, Group: 0},
		{ID: 109, Pos: Vec2{20, 0.8}, Value: 25, Group: 0},
	}
	m.CoreRules.TargetAlive = 10
	m.CoreRules.PeriodTicks = 300000 // 开局一波后再无补货：钱包精确可控
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpawn(1, Vec2{20, 0}, 0); err != nil {
		t.Fatal(err) // 受害者（吃 core 买等级）
	}
	if err := s.SetSpawn(2, Vec2{23, 0}, 1); err != nil {
		t.Fatal(err) // 击杀者
	}
	victim := &s.robots[s.index[1]]
	killer := &s.robots[s.index[2]]
	buy := func(track uint8) { s.BuyUpgrade(1, track) }
	seq := uint32(0)
	fire := func(tick uint32, aim float64) {
		seq++
		s.ApplyInput(2, &ombv1.ClientInput{Seq: seq, Fire: true, Aim: aim, AxisMask: uint32(AxisFire | AxisAim)})
	}
	// 1) 开局拾取 100 点（10 只 Mega×10 点）。五轨各买 L1-4（5×18=90）→ 钱包 10；
	//    尝试移速 L5（12）余额不足静默拒绝。阵亡时五轨均 L4：基准 = 最高轨
	//    （平级取 hp）L5 成本 12，10 ≥ 6 → 情形 A（只掉钱包 10）。
	s.Tick()
	if victim.Upg.Points != 100 {
		t.Fatalf("victim points = %d, want 100", victim.Upg.Points)
	}
	for _, track := range []uint8{TrackHP + 1, TrackSpeed + 1, TrackShield + 1, TrackAttack + 1, TrackEnergy + 1} {
		for l := 0; l < BountyStateLevel; l++ {
			buy(track)
			s.Tick()
		}
	}
	buy(TrackSpeed + 1) // L5 需 12 点，余额 10 → 静默拒绝
	s.Tick()
	if victim.Upg.Points != 10 {
		t.Fatalf("wallet = %d, want 10", victim.Upg.Points)
	}
	for track := 0; track < UpgradeTrackCount; track++ {
		if victim.Upg.Levels[track] != BountyStateLevel {
			t.Fatalf("all tracks should be L4 before the kill: %+v", victim.Upg)
		}
	}
	// 2) 击杀者持续开火（23,0)→(20,0) 方向 aim=π）直至击杀；受害者 180 HP。
	for tick := 0; tick < 600 && victim.State != Dead; tick++ {
		fire(uint32(tick), math.Pi)
		s.Tick()
	}
	if victim.State != Dead {
		t.Fatal("victim not killed")
	}
	if len(s.pointDrops) == 0 || dropTotal(s.pointDrops) != 10 {
		t.Fatalf("case A must scatter exactly the wallet: %d", dropTotal(s.pointDrops))
	}
	if victim.Upg.Levels[TrackHP] != 4 {
		t.Fatalf("case A must not drop levels: %+v", victim.Upg)
	}
	// 3) 击杀者走向第一只晶片并拾取（直播侧读实时坐标做 bang-bang 控制，
	//    重放侧同输入序列必然命中同一坐标）。
	target := s.pointDrops[0]
	for step := 0; step < 240 && s.pointDrops != nil; step++ {
		dx, dy := target.Pos.X-killer.Position.X, target.Pos.Y-killer.Position.Y
		n := math.Hypot(dx, dy)
		if n < 0.05 {
			break
		}
		seq++
		s.ApplyInput(2, &ombv1.ClientInput{Seq: seq, MoveX: int32(1000 * dx / n), MoveY: int32(1000 * dy / n), AxisMask: uint32(AxisMove)})
		s.Tick()
		if len(s.pointDrops) == 0 {
			break
		}
		target = s.pointDrops[0]
	}
	if killer.Upg.Points != 10 {
		t.Fatalf("killer points = %d, want 10 (picked scattered orb)", killer.Upg.Points)
	}
	live := s.Snapshot()
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	// 4) 重放到同 tick：终局状态与直播一致。
	replayed, err := ReplayTo(bytes.NewReader(buf.Bytes()), live.Tick, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(replayed.Snapshot(), live) {
		t.Fatal("replayed final checkpoint differs from live match")
	}
}
