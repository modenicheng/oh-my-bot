// Package sim implements the single-owner, externally clocked authoritative match.
// Mutating methods, state inspection and sink callbacks are single-owner. The
// published View/WorldView and entity-view getters are safe for concurrent
// readers; network/script workers submit commands through the owner.
package sim

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync/atomic"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// SimulationVersion distinguishes deterministic gameplay semantics in saved
// states. Version 0 predates robot contact impulses; version 2 adds tick-scoped
// script intent, held Dash, and swept circle pickup contact. Version 3 retains
// interrupted uplink progress briefly, then decays it at a deterministic cadence.
const SimulationVersion = 3

const (
	TickRate                   = 60
	DT                         = 1.0 / TickRate
	CoreOpenTick        uint32 = 4 * 60 * TickRate
	MatchTicks          uint32 = 8 * 60 * TickRate
	CheckpointInterval  uint32 = 60 * TickRate
	WallHitInterval     uint32 = TickRate / 2
	MaxSpeed                   = 8.0
	Acceleration               = 24.0
	RobotRadius                = 0.6
	MaxHP                      = 100.0
	MaxEnergy                  = 100.0
	FrameBudget                = 12 * time.Millisecond
	DefaultScriptBudget        = 10 * time.Millisecond
)

// EventSink must not mutate the Sim or block on unbounded work. Persistence
// implementations expose failures separately because this contract has no error.
type EventSink interface {
	OnEvent(tick uint32, ev *ombv1.ServerEvent)
}

// CheckpointSink is an optional extension of EventSink for the complete log, not
// the bandwidth-limited network projection. Values are detached from live state.
type CheckpointSink interface {
	OnCheckpoint(state Checkpoint)
}

// ReplaySink preserves information absent from ServerEvent: the initial player
// table/map and each consumed control change. MatchEventLog implements both
// optional interfaces. Wrapping sinks must forward them to retain replay data.
type ReplaySink interface {
	OnMatchInit(state Checkpoint)
	OnInput(tick uint32, robotID uint32, input Input)
}

// ScriptRuntime is a worker-level placeholder, deliberately not called by Tick.
// A future pool owns concurrency and cancellation, supplies a shared frame
// deadline, and carries unfinished jobs to the next frame as idle, not errors.
// Implementations must honor ctx; runtime-specific quota interruption belongs
// in the implementation, not this deterministic state machine.
type ScriptRuntime interface {
	Run(ctx context.Context, frame ScriptFrame) (Input, error)
}

func (v Vec2) finite() bool {
	return !math.IsNaN(v.X) && !math.IsNaN(v.Y) && !math.IsInf(v.X, 0) && !math.IsInf(v.Y, 0)
}

type RobotStatus string

const (
	Alive RobotStatus = "alive"
	Dead  RobotStatus = "dead"
)

// Input is a plain value copy: retaining a ClientInput pointer (or copying its
// protobuf runtime mutex) would let the caller corrupt a queued command.
// AxisMask records operated axes, including explicit zero/false release values.
type Input struct {
	AxisMask AxisMask `json:"axis_mask"`
	Seq      uint32   `json:"seq"`
	MoveX    int32    `json:"move_x"`
	MoveY    int32    `json:"move_y"`
	Fire     bool     `json:"fire"`
	Aim      float64  `json:"aim"`
	Dash     bool     `json:"dash"`
	Shield   bool     `json:"shield"`
	Interact bool     `json:"interact"`
}

// Robot includes control/cooldown state needed to continue from a checkpoint.
// Sim only exposes copies; all mutation goes through its queued APIs.
// HP and Energy use game units, not the wire protocol's x10 representation.
type Robot struct {
	ConsumedSeq     uint32       `json:"consumed_seq"`
	Control         ControlState `json:"control"`
	Combat          CombatState  `json:"combat"`
	Nick            string       `json:"nick,omitempty"`
	Color           string       `json:"color,omitempty"`
	ID              uint32       `json:"id"`
	Position        Vec2         `json:"position"`
	PathStart       Vec2         `json:"path_start"`
	Velocity        Vec2         `json:"velocity"`
	HP              float64      `json:"hp"`
	Energy          float64      `json:"energy"`
	State           RobotStatus  `json:"state"`
	Heading         float64      `json:"heading"`
	SpawnPosition   Vec2         `json:"spawn_position"`
	Sector          uint32       `json:"sector"`
	Input           Input        `json:"input"`
	PendingInput    Input        `json:"pending_input"`
	InputPending    bool         `json:"input_pending"`
	LatestSeq       uint32       `json:"latest_seq"`
	HasSeq          bool         `json:"has_seq"`
	RespawnPending  bool         `json:"respawn_pending"`
	LastWallHitTick uint32       `json:"last_wall_hit_tick"`
	HasWallHit      bool         `json:"has_wall_hit"`
	// Snippet 埋点节流：与 WallHit 同粒度思路，避免 60Hz 刷屏事件。
	LastSnippetUseTick uint32 `json:"last_snippet_use_tick"`
	HasSnippetUse      bool   `json:"has_snippet_use"`
}

// Checkpoint is the complete state of this stage, including static geometry,
// held/pending controls, sequence guards and per-robot collision throttles.
type HealthPack struct {
	ID      uint32 `json:"id"`
	Pos     Vec2   `json:"pos"`
	ReadyAt uint32 `json:"ready_at"`
}

type Checkpoint struct {
	SimulationVersion int          `json:"simulation_version,omitempty"`
	Tick              uint32       `json:"tick"`
	Seed              uint64       `json:"seed"`
	Phase             ombv1.Phase  `json:"phase"`
	Ended             bool         `json:"ended"`
	Robots            []Robot      `json:"robots"`
	Walls             []Wall       `json:"walls"`
	Map               *MapDef      `json:"map,omitempty"`
	RNG               uint64       `json:"rng"`
	NextProjectile    uint32       `json:"next_projectile"`
	Projectiles       []Projectile `json:"projectiles"`
	Cores             []CoreView   `json:"cores"`
	HealthPacks       []HealthPack `json:"health_packs"`
	Uplinks           []Uplink     `json:"uplinks"`
}

type consumedInput struct {
	robotID uint32
	input   Input
}

// Sim never starts a goroutine/timer and never consults wall time. Tick is the
// only clock. The sink owns wall timestamps and persistence latency/errors.
type Sim struct {
	simulationVersion int
	seed              uint64
	tick              uint32
	phase             ombv1.Phase
	ended             bool
	robots            []Robot
	index             map[uint32]int
	walls             []Wall
	sink              EventSink
	events            []*ombv1.ServerEvent
	consumed          []consumedInput
	mapDef            *MapDef
	rng               uint64
	nextProjectile    uint32
	projectiles       []Projectile
	cores             []CoreView
	healthPacks       []HealthPack
	uplinks           []Uplink
	view              atomic.Pointer[WorldView]
	controlEvents     []controlRecord
}

// NewSim uses player IDs as robot IDs. Zero/duplicate IDs panic, as they violate
// the entity identity invariant and this constructor has no error result.
// Map generation is intentionally absent: spawns default to the origin and can
// be configured before tick 1. Player count validation belongs to the room.
// SetRobotMeta 注入昵称与配色。须在 Tick 驱动启动前调用（装配期单线程，无锁）。
func (s *Sim) SetRobotMeta(id uint32, nick, color string) {
	if i, ok := s.index[id]; ok {
		s.robots[i].Nick, s.robots[i].Color = nick, color
	}
}

func NewSim(seed uint64, playerIDs []uint32, eventSink EventSink) *Sim {
	ids := append([]uint32(nil), playerIDs...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	s := &Sim{simulationVersion: SimulationVersion, seed: seed, rng: seed, nextProjectile: 1, phase: ombv1.Phase_OUTER_RING, sink: eventSink,
		robots: make([]Robot, len(ids)), index: make(map[uint32]int, len(ids)),
		walls: make([]Wall, 0)}
	for i, id := range ids {
		if id == 0 || (i > 0 && ids[i-1] == id) {
			panic("sim: robot IDs must be unique and nonzero")
		}
		s.index[id] = i
		// Assist defaults off: script arbitration is opt-in per player/room.
		s.robots[i] = Robot{ID: id, HP: MaxHP, Energy: MaxEnergy, State: Alive, Sector: uint32(i % 8), Control: ControlState{}}
		if id >= s.nextProjectile {
			s.nextProjectile = id + 1
		}
	}
	s.publishView()
	return s
}

func (s *Sim) CurrentTick() uint32 { return s.tick }
func (s *Sim) Phase() ombv1.Phase  { return s.phase }
func (s *Sim) Ended() bool         { return s.ended }

func (s *Sim) Robot(id uint32) (Robot, bool) {
	i, ok := s.index[id]
	if !ok {
		return Robot{}, false
	}
	return cloneRobot(s.robots[i]), true
}

func (s *Sim) Snapshot() Checkpoint {
	robots := make([]Robot, len(s.robots))
	for i, r := range s.robots {
		robots[i] = cloneRobot(r)
	}
	return Checkpoint{SimulationVersion: s.simulationVersion, Tick: s.tick, Seed: s.seed, Phase: s.phase, Ended: s.ended,
		Robots: robots, Walls: append([]Wall{}, s.walls...), Map: cloneMap(s.mapDef), RNG: s.rng,
		NextProjectile: s.nextProjectile, Projectiles: append([]Projectile{}, s.projectiles...),
		Cores: append([]CoreView{}, s.cores...), HealthPacks: append([]HealthPack{}, s.healthPacks...), Uplinks: cloneUplinks(s.uplinks)}
}

// SetSpawn configures initial/respawn positions before the match starts.
func (s *Sim) SetSpawn(robotID uint32, pos Vec2, sector uint32) error {
	i, ok := s.index[robotID]
	if s.tick != 0 || !ok || !pos.finite() || sector >= 8 {
		return fmt.Errorf("sim: invalid spawn configuration for robot %d", robotID)
	}
	if !s.insideArena(pos) {
		return fmt.Errorf("sim: spawn outside arena")
	}
	for _, wall := range s.walls {
		if overlapsWall(pos, wall) {
			return fmt.Errorf("sim: spawn overlaps wall %d", wall.ID)
		}
	}
	if s.zoneLocked() && pos.Len() < s.mapDef.CoreZone.Radius+RobotRadius {
		return fmt.Errorf("sim: spawn inside locked core")
	}
	s.robots[i].Position, s.robots[i].SpawnPosition, s.robots[i].Sector = pos, pos, sector
	s.publishView()
	return nil
}

// ApplyInput queues only the newest sequence for the next tick. Sequence zero
// is valid initially; duplicates, older values and uint32 wrap are rejected.
// The last consumed control remains held until replaced (including a stop).
func (s *Sim) ApplyInput(robotID uint32, in *ombv1.ClientInput) bool {
	i, ok := s.index[robotID]
	if !ok || in == nil || s.ended || AxisMask(in.AxisMask)&^allAxes != 0 || math.IsNaN(in.Aim) || math.IsInf(in.Aim, 0) {
		return false
	}
	r := &s.robots[i]
	if r.HasSeq && in.Seq <= r.LatestSeq {
		return false
	}
	next := Input{Seq: in.Seq, AxisMask: AxisMask(in.AxisMask), MoveX: max(-1000, min(1000, in.MoveX)),
		MoveY: max(-1000, min(1000, in.MoveY)), Fire: in.Fire, Aim: in.Aim,
		Dash: in.Dash, Shield: in.Shield, Interact: in.Interact}
	// Coalesce disjoint axes received before this tick; never lose an earlier release.
	if r.InputPending {
		next = mergeInput(r.PendingInput, next)
	}
	r.PendingInput = next
	r.LatestSeq, r.HasSeq, r.InputPending = in.Seq, true, true
	return true
}

// Respawn is an explicit queued reset hook retained for callers and replay.
// Combat deaths instead schedule their automatic respawn 180 ticks later.
// Both preserve sequence/collision guards and personal Uplink cooldowns.
func (s *Sim) Respawn(robotID uint32) bool {
	i, ok := s.index[robotID]
	if !ok || s.ended || s.robots[i].RespawnPending {
		return false
	}
	s.robots[i].RespawnPending = true
	return true
}

// Tick advances exactly 1/60s: phase -> input/arbitration -> energy/movement ->
// projectiles/objectives -> immutable view -> events -> checkpoint. Script
// workers consume the last published frame and hand results to this owner.
// Ticks after 28800 are no-ops, including checkpoint/end emission.
func (s *Sim) Tick() {
	if s.ended {
		return
	}
	var initial *Checkpoint
	if s.tick == 0 {
		state := s.Snapshot()
		initial = &state
	}
	s.tick++
	s.events = s.events[:0]
	s.consumed = s.consumed[:0]
	if s.tick == 1 {
		s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_MatchStart{
			MatchStart: &ombv1.EvMatchStart{MapSeed: s.seed, Players: uint32(len(s.robots))}}})
	}
	s.controlEvents = s.controlEvents[:0]
	s.changePhase()
	s.consumeInputs()
	s.prepareCombat()
	s.moveAndCollide()
	s.softCollide()
	s.fireProjectiles()
	s.stepProjectiles()
	s.stepUplinks()
	s.stepCores()
	s.stepHealthPacks()
	s.publishView()
	s.emit(initial)
	if s.tick%CheckpointInterval == 0 {
		if sink, ok := s.sink.(CheckpointSink); ok {
			sink.OnCheckpoint(s.Snapshot())
		}
	}
	clear(s.events) // Do not retain sink-owned event payloads between ticks.
}

func (s *Sim) moveAndCollide() {
	for i := range s.robots {
		r := &s.robots[i]
		// PathStart anchors this tick's swept pickup tests; it is overwritten
		// every tick before stepCores/stepHealthPacks read it.
		r.PathStart = r.Position
		if r.State == Dead {
			r.Velocity = Vec2{}
			continue
		}
		direction := r.Control.Output.Move
		speed := MaxSpeed
		if r.Combat.ShieldOn {
			speed *= ShieldSpeedScale
		}
		if n := math.Hypot(direction.X, direction.Y); n > 1 {
			direction.X /= n
			direction.Y /= n
		}
		if r.Combat.DashUntil == s.tick && r.Velocity.Len() > speed {
			r.Velocity = r.Velocity.Scale(speed / r.Velocity.Len())
		}
		dv := Vec2{direction.X*speed - r.Velocity.X, direction.Y*speed - r.Velocity.Y}
		if n := math.Hypot(dv.X, dv.Y); n > Acceleration*DT {
			dv.X *= Acceleration * DT / n
			dv.Y *= Acceleration * DT / n
		}
		r.Velocity.X += dv.X
		r.Velocity.Y += dv.Y
		if r.Combat.DashUntil > s.tick {
			r.Velocity = r.Combat.DashDirection.Scale(DashSpeed)
		}
		s.slideRobot(r)
	}
}

// slideRobot advances one tick by sweeping the whole displacement against every
// obstacle: at each contact it cancels only the inward velocity and remaining
// displacement components, then re-sweeps the tangential remainder. Wall
// slides, rounded corners, crevices, dashes and the gen>=2 arena disk keep
// their tangential motion without penetration; bounded iterations keep a tick
// deterministic. WallHit keeps the first contact point and its normal impact.
func (s *Sim) slideRobot(r *Robot) {
	const maxContacts = 4
	remaining := Vec2{r.Velocity.X * DT, r.Velocity.Y * DT}
	firstContact, contactAt, impact := false, r.Position, 0.0
	for i := 0; i < maxContacts && remaining.Len() > collisionEpsilon; i++ {
		c := s.sweepContact(r.Position, remaining)
		t, normal, hit := c.t, c.normal, c.hit
		r.Position.X += remaining.X * t
		r.Position.Y += remaining.Y * t
		if !hit {
			break // free motion consumed the whole remainder (t == 1)
		}
		if n := normal.Len(); n <= collisionEpsilon {
			r.Velocity = Vec2{} // degenerate contact already inside a solid
			break
		} else {
			normal = normal.Scale(1 / n)
		}
		if !firstContact {
			firstContact, contactAt = true, r.Position
			if into := r.Velocity.X*normal.X + r.Velocity.Y*normal.Y; into < 0 {
				impact = -into
			}
		}
		remaining.X, remaining.Y = remaining.X*(1-t), remaining.Y*(1-t)
		into := remaining.X*normal.X + remaining.Y*normal.Y
		if into < 0 {
			remaining.X -= into * normal.X
			remaining.Y -= into * normal.Y
		}
		if into := r.Velocity.X*normal.X + r.Velocity.Y*normal.Y; into < 0 {
			r.Velocity.X -= into * normal.X
			r.Velocity.Y -= into * normal.Y
		}
		if s.boundedArena() && r.Position.Len() >= arenaCenterRadius-collisionEpsilon {
			// A straight tangent immediately exits a disk. Project its destination
			// into the disk, then sweep that interior chord against ALL obstacles.
			// The correction never moves the robot without a collision check.
			remaining = s.containInArena(r.Position.Add(remaining)).Sub(r.Position)
		}
	}
	r.Position = s.containInArena(r.Position)
	if firstContact && (!r.HasWallHit || s.tick-r.LastWallHitTick >= WallHitInterval) {
		r.LastWallHitTick, r.HasWallHit = s.tick, true
		s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_WallHit{
			WallHit: &ombv1.EvWallHit{Robot: r.ID, At: &ombv1.Vec2{X: contactAt.X, Y: contactAt.Y}, Impact: float32(impact)}}})
	}
}

func (s *Sim) changePhase() {
	if s.tick == CoreOpenTick {
		from := s.phase
		s.phase = ombv1.Phase_CORE_OPEN
		s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_PhaseChange{
			PhaseChange: &ombv1.EvPhaseChange{From: from, To: s.phase}}})
	}
}

func (s *Sim) emit(initial *Checkpoint) {
	if s.tick == MatchTicks {
		s.ended = true
		s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_MatchEnd{MatchEnd: &ombv1.EvMatchEnd{}}})
	}
	if replay, ok := s.sink.(ReplaySink); ok {
		if initial != nil {
			replay.OnMatchInit(*initial)
		}
		for _, in := range s.consumed {
			replay.OnInput(s.tick, in.robotID, in.input)
		}
	}
	if replay, ok := s.sink.(GameplayReplaySink); ok {
		for _, c := range s.controlEvents {
			replay.OnControl(s.tick, c.RobotID, c.Control)
		}
	}
	for _, ev := range s.events {
		ev.Tick = s.tick
		if s.sink != nil {
			s.sink.OnEvent(s.tick, ev)
		}
	}
}
