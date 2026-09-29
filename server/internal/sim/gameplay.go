package sim

// Gameplay constants are measured in meters, seconds and game units. All
// deadlines are ticks; no wall clock or worker can advance gameplay state.
const (
	FireInterval      uint32 = TickRate / 4
	FireCost                 = 5.0
	ProjectileSpeed          = 30.0
	EffectiveRange           = 16.0
	ProjectileRange          = 20.0
	MaxSpread                = 0.12 // radians at 20m; tuning default, not a damage falloff.
	ShotDamage               = 12.0
	EnergyRegen              = 10.0
	DashCost                 = 20.0
	DashCooldown      uint32 = 150
	DashDuration      uint32 = 18
	DashSpeed                = 16.0
	ShieldDrain              = 18.0
	ShieldDamageScale        = 0.35
	ShieldSpeedScale         = 0.8
	PulseCost                = 12.0
	PulseCooldown     uint32 = 120
	VisionRadius             = 20.0
	PulseRadius              = 32.0
	RespawnDelay      uint32 = 180
	InvulnDuration    uint32 = 240
	HackDuration      uint32 = 480
	HackCooldown      uint32 = 1800
	SayCooldown       uint32 = 180
)

type ControlState struct {
	Assist        bool            `json:"assist"`
	HumanAxes     AxisMask        `json:"human_axes"`
	Human         ArbitratedInput `json:"human"`
	Script        ArbitratedInput `json:"script"`
	ScriptAxes    AxisMask        `json:"script_axes"`
	Output        ArbitratedInput `json:"output"`
	PendingScript *ScriptCommands `json:"pending_script,omitempty"`
	ScriptPending bool            `json:"script_pending"`
	ScriptFailed  bool            `json:"script_failed"`
	ToggleCount   uint32          `json:"toggle_count"`
}

type CombatState struct {
	PulseRequested bool            `json:"pulse_requested"`
	Partner        uint32          `json:"partner"`
	FireReady      uint32          `json:"fire_ready"`
	DashReady      uint32          `json:"dash_ready"`
	DashUntil      uint32          `json:"dash_until"`
	DashDirection  Vec2            `json:"dash_direction"`
	ShieldOn       bool            `json:"shield_on"`
	PulseReady     uint32          `json:"pulse_ready"`
	PulseTick      uint32          `json:"pulse_tick"`
	SayReady       uint32          `json:"say_ready"`
	RespawnAt      uint32          `json:"respawn_at"`
	Invulnerable   bool            `json:"invulnerable"`
	InvulnUntil    uint32          `json:"invuln_until"`
	Damagers       map[uint32]bool `json:"damagers,omitempty"`
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

func (s *Sim) pairPartners() {
	order := make([]int, len(s.robots))
	for i := range order {
		order[i] = i
	}
	for i := len(order) - 1; i > 0; i-- {
		j := int(s.random() % uint64(i+1))
		order[i], order[j] = order[j], order[i]
	}
	for i := 0; i+1 < len(order); i += 2 {
		a, b := &s.robots[order[i]], &s.robots[order[i+1]]
		a.Combat.Partner, b.Combat.Partner = b.ID, a.ID
	}
}

func secondsLeft(now, until uint32) uint32 {
	if until <= now {
		return 0
	}
	return (until - now + TickRate - 1) / TickRate
}
