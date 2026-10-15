package sim

import (
	"math"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 升级玩法（ADR-0016）：core 换技能点、五维成长、赏金阵亡散落。
// 设计数值冻结于 docs/plans/upgrade-system.md；零级必须与 v4 常量严格相等
// （SimulationVersion<5 的回放不消费升级，等级恒为零）。
const (
	UpgradeTrackCount = 5
	UpgradeMaxLevel   = 10
	// core 拾取的技能点：普通（value 10）5 点、Mega（value 25）10 点。
	UpgradePointsCore = 5
	UpgradePointsMega = 10
	// BountyStateLevel：任一轨达到该等级即进入赏金状态（阵亡散落）。
	BountyStateLevel = 4
	// 单 tick 每 robot 排队的购买上限：防止伪造上游把回放消费循环撑大
	// （与 MaxControlToggles 同一 S-29 思路；正常客户端点击远达不到）。
	MaxUpgradeBuysPerTick = 8
	// 散落晶片寿命与拾取半径（本体米）；散布环带在死亡点周围。
	PointDropTTL        uint32 = 30 * TickRate
	PointDropRadius            = 0.4
	PointDropScatterMin        = 1.0
	PointDropScatterMax        = 4.0
	PointDropMaxOrbs           = 4
)

// 轨下标（协议 UpgradeSelf.levels 与 UpgradeTuning 数组同序）。
const (
	TrackHP = iota
	TrackSpeed
	TrackShield
	TrackAttack
	TrackEnergy
)

// UpgradeCosts[buyLevel-1] 是购买第 buyLevel 级的成本（五轨共用一条曲线：
// L6 起每级 ×1.5 陡增）。单轨累计 265，全树 1325。
var UpgradeCosts = [UpgradeMaxLevel]int32{2, 3, 5, 8, 12, 18, 27, 40, 60, 90}

// 每级增量：L1–5 满步长、L6–10 半步长（能量取 15 保持整数显示）。
// 盾量的步长作用于承伤系数（减量，即升盾=更能扛）。
const (
	StepHPFull     = 20.0
	StepHPHalf     = 10.0
	StepSpeedFull  = 0.4
	StepSpeedHalf  = 0.2
	StepShieldFull = 0.05
	StepShieldHalf = 0.01
	StepAtkFull    = 1.0
	StepAtkHalf    = 0.5
	StepEnergyFull = 25.0
	StepEnergyHalf = 15.0
)

// UpgradeState 是每机器人的局内成长状态；随 Robot 整体序列化进 Checkpoint
// （旧日志缺省反序列化为零值=无升级，天然回放兼容）。
type UpgradeState struct {
	Points int32                    `json:"points"`
	Levels [UpgradeTrackCount]uint8 `json:"levels"`
}

// stepAt 返回买到第 level 级时获得的增量（level 从 1 计）。
func stepAt(level int, full, half float64) float64 {
	if level <= 5 {
		return full
	}
	return half
}

// levelSum 累加前 level 级的全部增量。
func levelSum(level int, full, half float64) float64 {
	sum := 0.0
	for l := 1; l <= level; l++ {
		sum += stepAt(l, full, half)
	}
	return sum
}

// 派生上限的版本感知计算：RestoreCheckpoint 校验复用同一公式。
func maxHPFor(version int, u *UpgradeState) float64 {
	if version < 5 {
		return MaxHP
	}
	return MaxHP + levelSum(int(u.Levels[TrackHP]), StepHPFull, StepHPHalf)
}

func maxEnergyFor(version int, u *UpgradeState) float64 {
	if version < 5 {
		return MaxEnergy
	}
	return MaxEnergy + levelSum(int(u.Levels[TrackEnergy]), StepEnergyFull, StepEnergyHalf)
}

func moveSpeedFor(version int, u *UpgradeState) float64 {
	if version < 5 {
		return MaxSpeed
	}
	return MaxSpeed + levelSum(int(u.Levels[TrackSpeed]), StepSpeedFull, StepSpeedHalf)
}

func shieldScaleFor(version int, u *UpgradeState) float64 {
	if version < 5 {
		return ShieldDamageScale
	}
	return math.Max(0.05, ShieldDamageScale-levelSum(int(u.Levels[TrackShield]), StepShieldFull, StepShieldHalf))
}

func shotDamageFor2(version int, u *UpgradeState) float64 {
	if version < 4 {
		return legacyShotDamage
	}
	if version < 5 {
		return ShotDamage
	}
	return ShotDamage + levelSum(int(u.Levels[TrackAttack]), StepAtkFull, StepAtkHalf)
}

// 伤害取弹主（attacker）的攻击轨等级；其余属性取承受者自身。
func (s *Sim) shotDamageOf(r *Robot) float64 { return shotDamageFor2(s.simulationVersion, &r.Upg) }

func (s *Sim) maxHPOf(r *Robot) float64       { return maxHPFor(s.simulationVersion, &r.Upg) }
func (s *Sim) maxEnergyOf(r *Robot) float64   { return maxEnergyFor(s.simulationVersion, &r.Upg) }
func (s *Sim) moveSpeedOf(r *Robot) float64   { return moveSpeedFor(s.simulationVersion, &r.Upg) }
func (s *Sim) shieldScaleOf(r *Robot) float64 { return shieldScaleFor(s.simulationVersion, &r.Upg) }

// UpgradePointsFor 由 core 价值推导技能点（拾取奖励的确定性映射）。
func UpgradePointsFor(value int32) int32 {
	if value >= 25 {
		return UpgradePointsMega
	}
	return UpgradePointsCore
}

// BuyUpgrade 排队一次购买，下一 tick 在 consumeInputs 内消费（与 AssistToggle
// 同族的低频事件语义）。track 为 1–5；点数不足/满级在消费时静默拒绝——
// 客户端以随后快照的 SelfState.upgrade 为准，不做乐观更新。
func (s *Sim) BuyUpgrade(id uint32, track uint8) bool {
	i, ok := s.index[id]
	if !ok || s.ended || s.simulationVersion < 5 || track == 0 || track > UpgradeTrackCount {
		return false
	}
	c := &s.robots[i].Control
	if len(c.PendingUpgrades) >= MaxUpgradeBuysPerTick {
		return false
	}
	c.PendingUpgrades = append(c.PendingUpgrades, track)
	return true
}

// applyUpgrade 消费一次购买；死亡期间同样生效（复活按新上限满状态）。
// 血量轨顺带回血本次增量（限新上限内）。
func (s *Sim) applyUpgrade(r *Robot, track int) {
	if track <= 0 || track > UpgradeTrackCount {
		return
	}
	idx := track - 1
	level := int(r.Upg.Levels[idx])
	if level >= UpgradeMaxLevel {
		return
	}
	cost := UpgradeCosts[level]
	if r.Upg.Points < cost {
		return
	}
	r.Upg.Points -= cost
	r.Upg.Levels[idx] = uint8(level + 1)
	if idx == TrackHP && r.State == Alive {
		r.HP = math.Min(r.HP+stepAt(level+1, StepHPFull, StepHPHalf), s.maxHPOf(r))
	}
}

// bountyActive：任一轨 ≥ BountyStateLevel 即处于赏金状态。
func (u *UpgradeState) bountyActive() bool {
	for _, l := range u.Levels {
		if l >= BountyStateLevel {
			return true
		}
	}
	return false
}

// topTrack 返回等级最高的轨；平级取下标小者（hp→speed→shield→attack→energy）。
func (u *UpgradeState) topTrack() int {
	top := 0
	for t := 1; t < UpgradeTrackCount; t++ {
		if u.Levels[t] > u.Levels[top] {
			top = t
		}
	}
	return top
}

// applyBountyPenalty 在击杀路径上调用（victim 已 Dead）：
//   - 情形 A（自由点数 ≥ 基准×50%）：只散落全部自由点数；
//   - 情形 B（不足）：散落 自由点数 + 等级最高轨掉 1 级（购入成本全额转化为晶片）。
//
// 基准 = 等级最高轨的下一级成本（满级取当前级=重升成本）。掉级后若无一轨
// ≥4 自然脱离赏金（棘轮）；等级永不跌破 L3 以下（惩罚只在 ≥4 区间生效）。
func (s *Sim) applyBountyPenalty(v *Robot) {
	if s.simulationVersion < 5 || !v.Upg.bountyActive() {
		return
	}
	top := v.Upg.topTrack()
	level := int(v.Upg.Levels[top])
	base := UpgradeCosts[level-1]
	if level < UpgradeMaxLevel {
		base = UpgradeCosts[level]
	}
	wallet := v.Upg.Points
	total := wallet
	lost := false
	if wallet*2 < base {
		refund := UpgradeCosts[level-1]
		v.Upg.Levels[top] = uint8(level - 1)
		total += refund
		lost = true
		// 掉血量轨时上限即时收紧（阵亡路径 HP 已为 0，此处保持不变式）。
		if v.HP > s.maxHPOf(v) {
			v.HP = s.maxHPOf(v)
		}
	}
	v.Upg.Points = 0
	if total <= 0 {
		return
	}
	s.spawnPointDrops(v.Position, total)
	s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_PointDropSpawn{PointDropSpawn: &ombv1.EvPointDropSpawn{
		FromRobot: v.ID, At: &ombv1.Vec2{X: v.Position.X, Y: v.Position.Y}, TotalPoints: total, LevelLost: lost}}})
}

// spawnPointDrops 把总量拆成 ≤4 只晶片（每只约 15 点、余数归末只），散布在
// 死亡点周围的确定性 RNG 环带内（避墙/避锁区/场内钳制）。
func (s *Sim) spawnPointDrops(center Vec2, total int32) {
	if total <= 0 {
		return
	}
	k := int(math.Ceil(float64(total) / 15))
	k = max(1, min(PointDropMaxOrbs, k))
	base := total / int32(k)
	rem := total - base*int32(k)
	for i := 0; i < k; i++ {
		points := base
		if i == k-1 {
			points += rem
		}
		id := s.nextProjectile
		s.nextProjectile++
		s.pointDrops = append(s.pointDrops, PointDrop{ID: id, Pos: s.scatterPosition(center), Points: points, GoneAt: s.tick + PointDropTTL})
	}
}

func (s *Sim) scatterPosition(center Vec2) Vec2 {
	for i := 0; i < 16; i++ {
		ang := s.randomUnit() * 2 * math.Pi
		dist := PointDropScatterMin + s.randomUnit()*(PointDropScatterMax-PointDropScatterMin)
		p := center.Add(Vec2{X: math.Cos(ang) * dist, Y: math.Sin(ang) * dist})
		if s.freePosition(p) {
			return p
		}
	}
	return center
}

// stepPointDrops：到期消失（仅 tombstone，无事件）+ 扫掠接触拾取（谁碰归谁，
// 含复活本人；只加点数不给计分）。锁区内晶片遵循锁区拾取限制。
func (s *Sim) stepPointDrops() {
	if s.simulationVersion < 5 || len(s.pointDrops) == 0 {
		return
	}
	alive := s.pointDrops[:0]
	for _, d := range s.pointDrops {
		if d.GoneAt <= s.tick {
			continue
		}
		if s.zoneLocked() && d.Pos.Len() < s.mapDef.CoreZone.Radius {
			alive = append(alive, d)
			continue
		}
		picked := false
		for j := range s.robots {
			r := &s.robots[j]
			if r.State == Alive && s.sweptReach(r.PathStart, r.Position, d.Pos, PointDropRadius) {
				r.Upg.Points += d.Points
				s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_PointDropPickup{PointDropPickup: &ombv1.EvPointDropPickup{By: r.ID, DropId: d.ID, Points: d.Points}}})
				picked = true
				break
			}
		}
		if !picked {
			alive = append(alive, d)
		}
	}
	s.pointDrops = alive
}
