// Package sim — 对局模拟契约（Round 2 计划 A3，冻结版本）。
//
// 本文件只定义跨包契约：地图定义、帧视图、观察、脚本接口。
// 帧时序唯一 owner 是 Sim.Tick()（见 sim.go）：input → FrameView →
// Observation(AOI) → 脚本池(deadline) → 仲裁 → 物理 → 事件 → 快照。
//
// 契约规则：T1 gameplay 独占本包写权限，但不得破坏此处的公共 API；
// T2(script)/T3(snapshot)/T4(client) 对这些类型编程，禁止 import 内部细节。
package sim

import "math"

// ============ 基础几何 ============

type Vec2 struct{ X, Y float64 }

func (v Vec2) Add(o Vec2) Vec2      { return Vec2{v.X + o.X, v.Y + o.Y} }
func (v Vec2) Sub(o Vec2) Vec2      { return Vec2{v.X - o.X, v.Y - o.Y} }
func (v Vec2) Scale(k float64) Vec2 { return Vec2{v.X * k, v.Y * k} }
func (v Vec2) Len() float64         { return math.Hypot(v.X, v.Y) }

// Rect 为轴对齐实心矩形（AABB）——墙/扇区/锁区的统一几何。
type Rect struct{ Min, Max Vec2 }

func (r Rect) Contains(p Vec2) bool {
	return p.X >= r.Min.X && p.X <= r.Max.X && p.Y >= r.Min.Y && p.Y <= r.Max.Y
}

// ============ 地图定义（T0 mapgen 产、T1/T3/T4 消费） ============

// Phase 与 ombv1.Phase 数值对齐（0 unspecified / 1 OUTER_RING / 2 CORE_OPEN）。
type Phase uint8

const (
	PhaseOuterRing Phase = 1
	PhaseCoreOpen  Phase = 2
)

// MapDef 是地图的唯一权威描述，序列化 JSON 后经 EvMapBootstrap 下发客户端。
// 同 seed + generator_version 必产出 map_hash 一致的 MapDef（确定性契约）。
type MapDef struct {
	Version      int             `json:"version"`       // MapDef 结构版本（当前 1）
	GeneratorVer int             `json:"generator_ver"` // mapgen 算法版本
	Seed         uint64          `json:"seed"`
	MapHash      string          `json:"map_hash"` // 内容哈希（一致性校验）
	Walls        []Wall          `json:"walls"`    // 实体墙：挡移动+弹丸+视线
	Sectors      [8]Sector       `json:"sectors"`  // 出生扇区
	Uplinks      []UplinkDef     `json:"uplinks"`  // 含中央主桩
	HealthPacks  []HealthPackDef `json:"health_packs"`
	CorePads     []CorePadDef    `json:"core_pads"`  // 确定性刷新点
	CoreZone     CoreZoneDef     `json:"core_zone"`  // 中央锁区
	CoreRules    CoreRulesDef    `json:"core_rules"` // 刷新规则唯一 owner
}

// Wall 复用 collision.go 的定义（ID + Min + Max，AABB 语义与 Rect 同构）。

type Sector struct {
	ID        uint32 `json:"id"`
	SpawnArea Rect   `json:"spawn_area"` // 复活落点区域（扇区内随机取点）
	Center    Vec2   `json:"center"`
}

type UplinkDef struct {
	ID          uint32  `json:"id"`
	Pos         Vec2    `json:"pos"`
	Main        bool    `json:"main"`         // 中央主桩：+25，4:00 激活
	InteractR   float64 `json:"interact_r"`   // 交互半径（2.5m）
	ActivePhase Phase   `json:"active_phase"` // 主桩 CORE_OPEN，其余 OUTER_RING
}

type CorePadDef struct {
	ID    uint32 `json:"id"`
	Pos   Vec2   `json:"pos"`
	Group int    `json:"group"` // 刷新组（权重调度单位）
	Value int32  `json:"value"` // +10 普通 / +25 Mega
}

type HealthPackDef struct {
	ID  uint32 `json:"id"`
	Pos Vec2   `json:"pos"`
}

type CoreZoneDef struct {
	Radius      float64 `json:"radius"`       // 中央锁区半径（<30m）
	UnlockPhase Phase   `json:"unlock_phase"` // CORE_OPEN
}

// CoreRulesDef：Core 刷新规则的唯一 owner（T1 消费）。
type CoreRulesDef struct {
	PeriodTicks  int                 `json:"period_ticks"`  // 刷新周期（tick）
	GroupWeights map[Phase][]float64 `json:"group_weights"` // 各阶段各组刷新权重
}

// ============ 帧视图（T1 产、T2/T3 消费；每 tick 快照、不可变） ============

type FrameView struct {
	Tick      uint32 `json:"tick"`
	Phase     Phase  `json:"phase"`
	TimeLeftS uint32 `json:"time_left_s"`
	Map       *MapDef
}

// RobotView：机器人公开状态（HP/能量 ×10 定点，与 proto 对齐）。
type RobotView struct {
	ID          uint32
	Pos, Vel    Vec2
	Turret      float64 // 炮塔朝向（弧度）
	HpX10       int32
	EnergyX10   int32
	ShieldOn    bool
	Dashing     bool
	Dead        bool
	RespawnInS  uint32
	InvulnS     uint32 // 无敌剩余（0=无）
	Nick, Color string
}

type ProjView struct {
	ID, Owner uint32
	Pos       Vec2
	Heading   float64
	Color     string // 服务器权威射手颜色：射手离 AOI 后弹丸仍可自足着色（表现层专用）
}

type CoreView struct {
	ID    uint32
	Pos   Vec2
	Value int32
	Alive bool
}

type HealthPackView struct {
	ID         uint32
	Pos        Vec2
	Available  bool
	RespawnInS uint32
}

// UplinkView：桩公开状态。PersonalCDs 为观察者参数化数据（每玩家每桩 30s CD）。
type UplinkView struct {
	ID          uint32
	Pos         Vec2
	Main        bool
	Active      bool
	HackingID   uint32            // 正在引导的 robot（0=无人）
	ProgressS   float64           // 引导进度（0–8s）
	PersonalCDs map[uint32]uint32 // robotID → 剩余个人 CD（秒）——观察者按需取自身
}

// ============ Observation（T3 产、T2 消费；AOI 裁剪后的感知） ============

// Observation is one robot's read-only perception. Robots/projectiles follow range and
// line-of-sight clipping; cores, health packs, and uplinks are public map objects.
// PartnerID remains only as a zero-valued source-compatibility field for older integrations.
type Observation struct {
	Frame       FrameView
	Robots      []RobotView // 按扫描半径与视线裁剪
	PartnerID   uint32      // deprecated compatibility; live observations keep zero
	Cores       []CoreView
	HealthPacks []HealthPackView
	Uplinks     []UplinkView
	Projectiles []ProjView
}

// IsPartner is retained for source compatibility; live observations have no partner.
func (o *Observation) IsPartner(id uint32) bool { return o.PartnerID != 0 && id == o.PartnerID }

// ============ 脚本契约（T2 产、sim 时序消费） ============

// ScriptFrame 是每 tick 递给脚本的只读上下文。
type ScriptFrame struct {
	Self RobotView   // 本机机器人（未裁剪，自身恒可见）
	Obs  Observation // AOI 裁剪后的外部世界
}

// ScriptCommands 是脚本的输出意图。指针语义 = 本 tick 脚本操作过该轴
// （与 ClientInput.axis_mask 同构）；nil = 未操作，仲裁器保留人类/上次控制。
type ScriptCommands struct {
	Move      *Vec2    // 单位向量 × 速度意向
	Aim       *float64 // 炮塔目标角（弧度）
	Fire      *bool
	Dash      *bool
	Shield    *bool
	Interact  *bool
	Say       *string // 3s 冷却、自由文本
	PulseScan bool    // 主动脉冲（12 能量、2s CD、32m、不穿墙）
}

// Runtime 是脚本运行时抽象（goja 为 v1 唯一实现；多语言运行时预留）。
type Runtime interface {
	// Load 编译装载；失败返回 err（不替换旧版本——Hot Swap 语义）。
	Load(source string) error
	// Tick 在配额内执行一次脚本；超时/异常返回 err（调用方清脚本轴）。
	Tick(frame ScriptFrame) (ScriptCommands, error)
	// Rev 当前版本号（服务器侧单调）。
	Rev() uint32
	Close()
}

// ============ 仲裁契约（axis_mask 语义，ADR-0009） ============

// AxisMask：本帧实际操作过的轴（客户端输入与脚本输出共用语义）。
type AxisMask uint32

const (
	AxisMove AxisMask = 1 << iota
	AxisAim
	AxisFire
	AxisAbility // dash/shield/interact
)

// ArbitratedInput：仲裁后的最终控制输入（Sim 物理层唯一消费）。
type ArbitratedInput struct {
	Move     Vec2
	Aim      float64
	Fire     bool
	Dash     bool
	Shield   bool
	Interact bool
	// 来源标记（下发 SelfState.move_src/turret_src/fire_src/ability_src 供 UI 显示）。
	MoveSrc, TurretSrc, FireSrc, AbilitySrc byte // 'H' human / 'S' script / '-' none
}
