package sim

// Gameplay constants are measured in meters, seconds and game units. All
// deadlines are ticks; no wall clock or worker can advance gameplay state.
const (
	FireInterval       uint32 = TickRate / 4
	FireCost                  = 5.0
	ProjectileSpeed           = 36.0
	EffectiveRange            = 16.0
	ProjectileRange           = 20.0
	MaxSpread                 = 0.12 // radians at 20m; tuning default, not a damage falloff.
	ShotDamage                = 9.0
	EnergyRegen               = 10.0
	DashCost                  = 20.0
	DashCooldown       uint32 = 150
	DashDuration       uint32 = 18
	DashSpeed                 = 15.0
	DashAcceleration          = 60.0
	ShieldMinimumTicks uint32 = 3
	ShieldMinCooldown  uint32 = 12
	ShieldMaxCooldown  uint32 = 180
	ShieldCurveTicks   uint32 = 600
	ShieldDrain               = 18.0
	ShieldDamageScale         = 0.35
	ShieldSpeedScale          = 0.8
	PulseCost                 = 12.0
	PulseCooldown      uint32 = 120
	VisionRadius              = 20.0
	PulseRadius               = 32.0
	RespawnDelay       uint32 = 180
	InvulnDuration     uint32 = 240
	HackDuration       uint32 = 240
	HackCooldown       uint32 = 1800
	HackInterruptGrace uint32 = TickRate / 2
	HackDecayInterval  uint32 = TickRate
	HackDecayProgress  uint32 = TickRate / 2
	SayCooldown        uint32 = 180
)

// Pre-v4 balance values, retained verbatim so recorded matches replay under
// the constants they were played with. Live sims always use the block above.
const (
	legacyShotDamage      = 12.0
	legacyProjectileSpeed = 30.0
	legacyDashSpeed       = 16.0
)

const legacyHackDuration uint32 = 480

// Version-aware balance accessors: deterministic replay of old recordings must
// consume the values that were authoritative when the match was played.
func hackDurationFor(version int) uint32 {
	if version < 4 {
		return legacyHackDuration
	}
	return HackDuration
}

func (s *Sim) hackDuration() uint32 { return hackDurationFor(s.simulationVersion) }

func (s *Sim) projectileSpeed() float64 {
	if s.simulationVersion < 4 {
		return legacyProjectileSpeed
	}
	return ProjectileSpeed
}

func (s *Sim) dashSpeed() float64 {
	if s.simulationVersion < 4 {
		return legacyDashSpeed
	}
	return DashSpeed
}

func (s *Sim) dashAcceleration() float64 {
	if s.simulationVersion < 6 {
		return 96
	}
	return DashAcceleration
}

func ShieldCooldownTicks(duration uint32) uint32 {
	if duration <= ShieldMinimumTicks {
		return ShieldMinCooldown
	}
	if duration >= ShieldCurveTicks {
		return ShieldMaxCooldown
	}
	span := ShieldCurveTicks - ShieldMinimumTicks
	return ShieldMinCooldown + ((duration-ShieldMinimumTicks)*(ShieldMaxCooldown-ShieldMinCooldown)+span-1)/span
}

type ControlState struct {
	Assist        bool            `json:"assist"`
	HumanAxes     AxisMask        `json:"human_axes"`
	Human         ArbitratedInput `json:"human"`
	Script        ArbitratedInput `json:"script"`
	ScriptAxes    AxisMask        `json:"script_axes"`
	SnippetAxes   AxisMask        `json:"snippet_axes"` // 本 tick 脚本意图中由 Snippet 产生的轴（回放确定性保留）
	Output        ArbitratedInput `json:"output"`
	PendingScript *ScriptCommands `json:"pending_script,omitempty"`
	PendingSay    string          `json:"pending_say,omitempty"`
	ScriptPending bool            `json:"script_pending"`
	ScriptFailed  bool            `json:"script_failed"`
	ToggleCount   uint32          `json:"toggle_count"`
	// PendingUpgrades 排队下一 tick 消费的升级购买（ADR-0016；死亡期间同样
	// 有效）。与 ToggleCount/PendingSay 同族：排队 API 写入、consumeInputs 消费。
	PendingUpgrades []uint8 `json:"pending_upgrades,omitempty"`
}

type CombatState struct {
	PulseRequested bool               `json:"pulse_requested"`
	FireReady      uint32             `json:"fire_ready"`
	DashReady      uint32             `json:"dash_ready"`
	DashUntil      uint32             `json:"dash_until"`
	DashDirection  Vec2               `json:"dash_direction"`
	DashExhausted  bool               `json:"dash_exhausted"`
	ShieldOn       bool               `json:"shield_on"`
	ShieldStarted  uint32             `json:"shield_started,omitempty"`
	ShieldReady    uint32             `json:"shield_ready,omitempty"`
	PulseReady     uint32             `json:"pulse_ready"`
	PulseTick      uint32             `json:"pulse_tick"`
	SayReady       uint32             `json:"say_ready"`
	RespawnAt      uint32             `json:"respawn_at"`
	Invulnerable   bool               `json:"invulnerable"`
	InvulnUntil    uint32             `json:"invuln_until"`
	DamageBy       map[uint32]float64 `json:"damage_by,omitempty"` // effective HP removed during this life
}

type Projectile struct {
	ID          uint32  `json:"id"`
	Owner       uint32  `json:"owner"`
	Pos         Vec2    `json:"pos"`
	Heading     float64 `json:"heading"`
	BaseHeading float64 `json:"base_heading"`
	Spread      float64 `json:"spread"`
	Distance    float64 `json:"distance"`
}

type Uplink struct {
	Def           UplinkDef         `json:"def"`
	HackingID     uint32            `json:"hacking_id"`
	ProgressTicks uint32            `json:"progress_ticks"`
	DecayAt       uint32            `json:"decay_at,omitempty"` // v3+: next retained-progress decay tick while nobody is hacking
	ReadyAt       map[uint32]uint32 `json:"ready_at"`
}

// SplitMix64 has explicit checkpointable state and stable integer behavior.
func (s *Sim) random() uint64 {
	s.rng += 0x9e3779b97f4a7c15
	z := s.rng
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}
func (s *Sim) randomUnit() float64 { return float64(s.random()>>11) / (1 << 53) }

func secondsLeft(now, until uint32) uint32 {
	if until <= now {
		return 0
	}
	return (until - now + TickRate - 1) / TickRate
}
