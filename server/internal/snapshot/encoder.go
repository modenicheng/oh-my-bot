// encoder.go — SnapshotDelta 编码器（T3）。
//
// 逐观察者、逐 tick 有状态编码：full 全量 / delta 只含变化实体 + tombstone；
// base_tick = 上一帧 tick（客户端缺口检测依据）；ResyncRequest 后 ForceFull。
// 单编码器非并发安全（每连接一个）。
package snapshot

import (
	"encoding/json"
	"sort"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// SelfInput 是 Encode 的自机参数：自机 RobotView + 分轴仲裁结果（ADR-0009，
// 下发 SelfState.move_src/turret_src 供 UI 显示）。
type SelfInput struct {
	InputGeneration   uint32
	Robot             sim.RobotView
	MoveSrc           byte // 'H' human / 'S' script / '-' none
	TurretSrc         byte
	FireSrc           byte   // 开火轴来源（ADR-0009 分轴仲裁）
	AbilitySrc        byte   // 技能轴来源
	ManualAxes        uint32 // 当前被人工接管的轴位图（bit0 move/bit1 aim/bit2 fire/bit3 ability）
	AiRounds          uint32
	AiTokensK         uint32
	AssistOn          bool
	DashReadyTick     uint32
	FireReadyTick     uint32
	ShieldReadyTick   uint32
	ShieldStartedTick uint32
	// Upg 局内升级状态（ADR-0016）：私密下发 SelfState.upgrade（点数 + 五维等级）。
	Upg sim.UpgradeState
}

// DeltaEncoder 把某观察者的逐 tick Observation 编成 SnapshotDelta。
// 首帧（或 ForceFull 后）Full=true 全量；此后 delta 仅含变化实体 +
// 离开 AOI 的 tombstone；新入 AOI 实体携带完整元数据（nick/color）。
// base_tick 恒为上一帧 tick。
type DeltaEncoder struct {
	lastRobots      map[uint32]robotStamp
	lastProjs       map[uint32]projStamp
	lastCores       map[uint32]coreStamp
	lastUplinks     map[uint32]uplinkStamp
	lastDrops       map[uint32]dropStamp
	lastPacks       map[uint32]packStamp
	lastMap         string
	lastTick        uint32
	hasBaseline     bool // 是否已发过 full（首帧或 ForceFull）
	forceFull       bool
	compactMetadata bool
}

// Every wire-visible gameplay state participates in delta detection. In particular,
// idle turret turns and ability end frames must not wait for position/energy changes.
type robotStamp struct {
	pos                   sim.Vec2
	heading               float32
	hpX10, energyX10      int32
	maxHpX10, maxEnX10    int32 // 升级后上限（购买/掉级才变化；ADR-0016）
	shield, dashing, dead bool
	respawn, invuln       uint32
}

func stampRobot(r *sim.RobotView) robotStamp {
	return robotStamp{pos: r.Pos, heading: float32(r.Turret), hpX10: r.HpX10,
		energyX10: r.EnergyX10, maxHpX10: r.MaxHpX10, maxEnX10: r.MaxEnergyX10,
		shield: r.ShieldOn, dashing: r.Dashing,
		dead: r.Dead, respawn: r.RespawnInS, invuln: r.InvulnS}
}

// projStamp / coreStamp / uplinkStamp：各类别的变化子集。
type projStamp struct {
	pos   sim.Vec2
	color string
}

// coreStamp：Alive=false 不编码为实体——被拾取以 core_gone 表达。
type coreStamp struct {
	pos   sim.Vec2
	value int32
}

type uplinkStamp struct {
	progressX10 int32
	hackingID   uint32
	active      bool
	myCD        uint32
}

// dropStamp：晶片位置/数值（生成即静态；消失以 point_drop_gone 表达）。
type dropStamp struct {
	pos    sim.Vec2
	points int32
}

type packStamp struct {
	pos       sim.Vec2
	available bool
	respawn   uint32
}

// NewEncoder 创建编码器；首次 Encode 必为 full。
func NewEncoder() *DeltaEncoder {
	return &DeltaEncoder{
		lastRobots:  make(map[uint32]robotStamp),
		lastProjs:   make(map[uint32]projStamp),
		lastCores:   make(map[uint32]coreStamp),
		lastUplinks: make(map[uint32]uplinkStamp),
		lastDrops:   make(map[uint32]dropStamp),
	}
}

// ForceFull：下一帧强制全量（ResyncRequest 后调用）。
func (e *DeltaEncoder) ForceFull() { e.forceFull = true }

// SetCompactMetadata skips legacy local-map JSON work for negotiated binary clients.
// Only a capability transition invalidates the JSON baseline, so callers may set it
// each tick without making legacy deltas resend the map.
func (e *DeltaEncoder) SetCompactMetadata(compact bool) {
	if e.compactMetadata != compact {
		e.compactMetadata = compact
		e.lastMap = ""
	}
}

// Encode 编码一帧。self 为 nil 时 Self 字段留空（观战/异常路径）。
// tick 应与 obs.Frame.Tick 一致（由调用方保证单调）。
func (e *DeltaEncoder) Encode(tick, ackSeq uint32, phase sim.Phase, timeLeftS uint32, obs sim.Observation, self *SelfInput) *ombv1.SnapshotDelta {
	full := !e.hasBaseline || e.forceFull
	delta := &ombv1.SnapshotDelta{
		Tick:        tick,
		AckSeq:      ackSeq,
		BaseTick:    e.lastTick,
		Full:        full,
		Robots:      make([]*ombv1.RobotState, 0, len(obs.Robots)),
		Projectiles: make([]*ombv1.ProjectileState, 0, len(obs.Projectiles)),
		Cores:       make([]*ombv1.CoreState, 0, len(obs.Cores)),
		Uplinks:     make([]*ombv1.UplinkState, 0, len(obs.Uplinks)),
		HealthPacks: make([]*ombv1.HealthPackState, 0, len(obs.HealthPacks)),
	}
	delta.Phase = phaseToProto(phase)
	delta.TimeLeftS = timeLeftS
	if obs.Frame.Map != nil && obs.Frame.Map.Partial {
		if !e.compactMetadata {
			data, _ := json.Marshal(obs.Frame.Map)
			mapJSON := string(data)
			if full || mapJSON != e.lastMap {
				delta.MapJson = &mapJSON
			}
			e.lastMap = mapJSON
		}
		radius := obs.VisionRadius
		delta.VisionRadius = &radius
	}

	// ---- Robots ----
	nextRobots := make(map[uint32]robotStamp, len(obs.Robots))
	for i := range obs.Robots {
		r := &obs.Robots[i]
		nextRobots[r.ID] = stampRobot(r)
		if full {
			delta.Robots = append(delta.Robots, encodeRobot(r, true))
			continue
		}
		prev, seen := e.lastRobots[r.ID]
		if !seen {
			delta.Robots = append(delta.Robots, encodeRobot(r, true)) // 新入 AOI：完整元数据
			continue
		}
		if prev != nextRobots[r.ID] {
			delta.Robots = append(delta.Robots, encodeRobot(r, false))
		}
	}

	// ---- Projectiles：新入或位移即发 ----
	nextProjs := make(map[uint32]projStamp, len(obs.Projectiles))
	for i := range obs.Projectiles {
		p := &obs.Projectiles[i]
		nextProjs[p.ID] = projStamp{pos: p.Pos, color: p.Color}
		if full {
			delta.Projectiles = append(delta.Projectiles, encodeProj(p))
			continue
		}
		prev, seen := e.lastProjs[p.ID]
		if !seen || prev != nextProjs[p.ID] {
			delta.Projectiles = append(delta.Projectiles, encodeProj(p))
		}
	}

	// ---- Cores：恒全量集合内的增量；被拾取以 gone 表达 ----
	nextCores := make(map[uint32]coreStamp, len(obs.Cores))
	for i := range obs.Cores {
		c := &obs.Cores[i]
		if !c.Alive {
			continue
		}
		nextCores[c.ID] = coreStamp{pos: c.Pos, value: c.Value}
		if full {
			delta.Cores = append(delta.Cores, encodeCore(c))
			continue
		}
		prev, seen := e.lastCores[c.ID]
		if !seen || prev.pos != c.Pos || prev.value != c.Value {
			delta.Cores = append(delta.Cores, encodeCore(c))
		}
	}

	// ---- Uplinks：恒全量；引导进度/引导者/个人 CD/激活变化即发 ----
	observer := selfID(self)
	nextUplinks := make(map[uint32]uplinkStamp, len(obs.Uplinks))
	for i := range obs.Uplinks {
		u := &obs.Uplinks[i]
		st := uplinkStamp{progressX10: int32(u.ProgressS * 10), hackingID: u.HackingID, active: u.Active}
		if cd, ok := u.PersonalCDs[observer]; ok {
			st.myCD = cd
		}
		nextUplinks[u.ID] = st
		if full {
			delta.Uplinks = append(delta.Uplinks, encodeUplink(u, observer))
			continue
		}
		prev, seen := e.lastUplinks[u.ID]
		if !seen || prev != st {
			delta.Uplinks = append(delta.Uplinks, encodeUplink(u, observer))
		}
	}
	// Uplink 恒全量（地图对象）——proto 无 uplink_gone 字段。

	// Keep exact simulation state here; compact wire quantization has its own baseline.
	nextPacks := make(map[uint32]packStamp, len(obs.HealthPacks))
	for i := range obs.HealthPacks {
		pack := &obs.HealthPacks[i]
		st := packStamp{pos: pack.Pos, available: pack.Available, respawn: pack.RespawnInS}
		nextPacks[pack.ID] = st
		if prev, seen := e.lastPacks[pack.ID]; full || !seen || prev != st {
			delta.HealthPacks = append(delta.HealthPacks, encodeHealthPack(pack))
		}
	}

	// ---- PointDrops（ADR-0016）：公共对象、有界集合（单只 ≤4 点、每次死亡
	// 随机多只、30s TTL），恒全量集合内的增量；消失（拾取/到期）以 gone 表达。 ----
	nextDrops := make(map[uint32]dropStamp, len(obs.PointDrops))
	for i := range obs.PointDrops {
		d := &obs.PointDrops[i]
		nextDrops[d.ID] = dropStamp{pos: d.Pos, points: d.Points}
		if full {
			delta.PointDrops = append(delta.PointDrops, encodePointDrop(d))
			continue
		}
		if prev, seen := e.lastDrops[d.ID]; !seen || prev != nextDrops[d.ID] {
			delta.PointDrops = append(delta.PointDrops, encodePointDrop(d))
		}
	}

	delta.Self = encodeSelf(self)

	if !full {
		delta.RobotGone = goneIDs(e.lastRobots, nextRobots)
		delta.ProjectileGone = goneIDs(e.lastProjs, nextProjs)
		delta.CoreGone = goneIDs(e.lastCores, nextCores)
		delta.PointDropGone = goneIDs(e.lastDrops, nextDrops)
		delta.UplinkGone = goneIDs(e.lastUplinks, nextUplinks)
		delta.HealthPackGone = goneIDs(e.lastPacks, nextPacks)
	}

	// 提交基线。
	e.lastRobots = nextRobots
	e.lastProjs = nextProjs
	e.lastCores = nextCores
	e.lastUplinks = nextUplinks
	e.lastDrops = nextDrops
	e.lastPacks = nextPacks
	e.lastTick = tick
	if full {
		e.hasBaseline = true
		e.forceFull = false
	}
	return delta
}

func selfID(s *SelfInput) uint32 {
	if s == nil {
		return 0
	}
	return s.Robot.ID
}

// goneIDs：上一帧在、本帧不在的实体 id。
// goneIDs 按 id 升序输出消失实体：Go map 遍历序随机，不排序会使同一状态
// 在两次运行/两条路径下产生字节不同的 tombstone 顺序（语义等价但破坏
// 「同 seed 同字节」的对照与排障基线）。
func goneIDs[T any](prev map[uint32]T, next map[uint32]T) []uint32 {
	var gone []uint32
	for id := range prev {
		if _, ok := next[id]; !ok {
			gone = append(gone, id)
		}
	}
	sort.Slice(gone, func(i, j int) bool { return gone[i] < gone[j] })
	return gone
}

func phaseToProto(p sim.Phase) ombv1.Phase {
	if p == sim.PhaseCoreOpen {
		return ombv1.Phase_CORE_OPEN
	}
	return ombv1.Phase_OUTER_RING
}

func encodeRobot(r *sim.RobotView, withMeta bool) *ombv1.RobotState {
	rs := &ombv1.RobotState{
		Base: &ombv1.EntityBase{
			Id:      r.ID,
			Pos:     &ombv1.Vec2{X: r.Pos.X, Y: r.Pos.Y},
			Heading: float32(r.Turret),
		},
		HpX10:      r.HpX10,
		EnergyX10:  r.EnergyX10,
		ShieldOn:   r.ShieldOn,
		Dashing:    r.Dashing,
		Dead:       r.Dead,
		RespawnInS: r.RespawnInS,
	}
	invuln := r.InvulnS
	rs.InvulnS = &invuln
	maxHP, maxEnergy := r.MaxHpX10, r.MaxEnergyX10
	rs.MaxHpX10, rs.MaxEnergyX10 = &maxHP, &maxEnergy
	if withMeta {
		rs.Nick = r.Nick
		rs.Color = r.Color
	}
	return rs
}

func encodeProj(p *sim.ProjView) *ombv1.ProjectileState {
	return &ombv1.ProjectileState{
		Base: &ombv1.EntityBase{
			Id:      p.ID,
			Pos:     &ombv1.Vec2{X: p.Pos.X, Y: p.Pos.Y},
			Heading: float32(p.Heading),
		},
		OwnerId: p.Owner,
		Color:   p.Color,
	}
}

func encodeCore(c *sim.CoreView) *ombv1.CoreState {
	return &ombv1.CoreState{
		Base: &ombv1.EntityBase{
			Id:  c.ID,
			Pos: &ombv1.Vec2{X: c.Pos.X, Y: c.Pos.Y},
		},
		Value: c.Value,
	}
}

func encodePointDrop(d *sim.PointDropView) *ombv1.PointDropState {
	return &ombv1.PointDropState{
		Base: &ombv1.EntityBase{
			Id:  d.ID,
			Pos: &ombv1.Vec2{X: d.Pos.X, Y: d.Pos.Y},
		},
		Points: d.Points,
	}
}

func encodeHealthPack(pack *sim.HealthPackView) *ombv1.HealthPackState {
	return &ombv1.HealthPackState{
		Base:      &ombv1.EntityBase{Id: pack.ID, Pos: &ombv1.Vec2{X: pack.Pos.X, Y: pack.Pos.Y}},
		Available: pack.Available, RespawnInS: pack.RespawnInS,
	}
}

func encodeUplink(u *sim.UplinkView, observerID uint32) *ombv1.UplinkState {
	us := &ombv1.UplinkState{
		Base: &ombv1.EntityBase{
			Id:  u.ID,
			Pos: &ombv1.Vec2{X: u.Pos.X, Y: u.Pos.Y},
		},
		HackingId:   u.HackingID,
		ProgressX10: int32(u.ProgressS * 10),
	}
	if cd, ok := u.PersonalCDs[observerID]; ok {
		us.MyCooldownS = cd
	}
	// Ready = 桩激活 + 本机个人 CD 归零 + 无人引导（本机视角语义）。
	us.Ready = u.Active && us.MyCooldownS == 0 && u.HackingID == 0
	return us
}

func encodeSelf(s *SelfInput) *ombv1.SelfState {
	if s == nil {
		return nil
	}
	assist, dashReady, fireReady := s.AssistOn, s.DashReadyTick, s.FireReadyTick
	fireSrc, abilitySrc, manualAxes := ctrlSrc(s.FireSrc), ctrlSrc(s.AbilitySrc), s.ManualAxes
	levels := make([]uint32, len(s.Upg.Levels))
	for i, l := range s.Upg.Levels {
		levels[i] = uint32(l)
	}
	points := uint32(0)
	if s.Upg.Points > 0 {
		points = uint32(s.Upg.Points)
	}
	return &ombv1.SelfState{
		InputGeneration:   &s.InputGeneration,
		RobotId:           s.Robot.ID,
		MoveSrc:           ctrlSrc(s.MoveSrc),
		TurretSrc:         ctrlSrc(s.TurretSrc),
		AiRoundsLeft:      s.AiRounds,
		AiTokensLeftK:     s.AiTokensK,
		AssistOn:          &assist,
		DashReadyTick:     &dashReady,
		FireReadyTick:     &fireReady,
		FireSrc:           &fireSrc,
		AbilitySrc:        &abilitySrc,
		ManualAxesMask:    &manualAxes,
		Upgrade:           &ombv1.UpgradeSelf{Points: points, Levels: levels},
		ShieldReadyTick:   &s.ShieldReadyTick,
		ShieldStartedTick: &s.ShieldStartedTick,
	}
}

func ctrlSrc(b byte) ombv1.ControlSource {
	switch b {
	case 'H':
		return ombv1.ControlSource_CS_HUMAN
	case 'S':
		return ombv1.ControlSource_CS_SCRIPT
	case 'N':
		return ombv1.ControlSource_CS_SNIPPET
	default:
		return ombv1.ControlSource_CS_UNSPECIFIED
	}
}
