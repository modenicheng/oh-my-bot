// Package sim implements the single-owner, externally clocked authoritative match.
// Call all methods and sink callbacks serially; network and script workers must
// hand inputs to the owner rather than mutate a running simulation.
package sim

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

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

// ScriptFrame will be supplemented with visibility-filtered observations by the
// perception layer. Never give scripts the unrestricted checkpoint/player table.
type ScriptFrame struct {
	Tick uint32
	Self Robot
}

type Vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
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
// Fire, Dash, Shield and Interact are recorded but not executed in this stage.
type Input struct {
	Seq      uint32  `json:"seq"`
	MoveX    int32   `json:"move_x"`
	MoveY    int32   `json:"move_y"`
	Fire     bool    `json:"fire"`
	Aim      float64 `json:"aim"`
	Dash     bool    `json:"dash"`
	Shield   bool    `json:"shield"`
	Interact bool    `json:"interact"`
}

// Robot includes control/cooldown state needed to continue from a checkpoint.
// Sim only exposes copies; all mutation goes through its queued APIs.
// HP and Energy use game units, not the wire protocol's x10 representation.
type Robot struct {
	ID              uint32      `json:"id"`
	Position        Vec2        `json:"position"`
	Velocity        Vec2        `json:"velocity"`
	HP              float64     `json:"hp"`
	Energy          float64     `json:"energy"`
	State           RobotStatus `json:"state"`
	Heading         float64     `json:"heading"`
	SpawnPosition   Vec2        `json:"spawn_position"`
	Sector          uint32      `json:"sector"`
	Input           Input       `json:"input"`
	PendingInput    Input       `json:"pending_input"`
	InputPending    bool        `json:"input_pending"`
	LatestSeq       uint32      `json:"latest_seq"`
	HasSeq          bool        `json:"has_seq"`
	RespawnPending  bool        `json:"respawn_pending"`
	LastWallHitTick uint32      `json:"last_wall_hit_tick"`
	HasWallHit      bool        `json:"has_wall_hit"`
}

// Checkpoint is the complete state of this stage, including static geometry,
// held/pending controls, sequence guards and per-robot collision throttles.
type Checkpoint struct {
	Tick   uint32      `json:"tick"`
	Seed   uint64      `json:"seed"`
	Phase  ombv1.Phase `json:"phase"`
	Ended  bool        `json:"ended"`
	Robots []Robot     `json:"robots"`
	Walls  []Wall      `json:"walls"`
}

type consumedInput struct {
	robotID uint32
	input   Input
}

// Sim never starts a goroutine/timer and never consults wall time. Tick is the
// only clock. The sink owns wall timestamps and persistence latency/errors.
type Sim struct {
	seed     uint64
	tick     uint32
	phase    ombv1.Phase
	ended    bool
	robots   []Robot
	index    map[uint32]int
	walls    []Wall
	sink     EventSink
	events   []*ombv1.ServerEvent
	consumed []consumedInput
}

// NewSim uses player IDs as robot IDs. Zero/duplicate IDs panic, as they violate
// the entity identity invariant and this constructor has no error result.
// Map generation is intentionally absent: spawns default to the origin and can
// be configured before tick 1. Player count validation belongs to the room.
func NewSim(seed uint64, playerIDs []uint32, eventSink EventSink) *Sim {
	ids := append([]uint32(nil), playerIDs...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	s := &Sim{seed: seed, phase: ombv1.Phase_OUTER_RING, sink: eventSink,
		robots: make([]Robot, len(ids)), index: make(map[uint32]int, len(ids)),
		walls: make([]Wall, 0)}
	for i, id := range ids {
		if id == 0 || (i > 0 && ids[i-1] == id) {
			panic("sim: robot IDs must be unique and nonzero")
		}
		s.index[id] = i
		s.robots[i] = Robot{ID: id, HP: MaxHP, Energy: MaxEnergy, State: Alive, Sector: uint32(i % 8)}
	}
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
	return s.robots[i], true
}

func (s *Sim) Snapshot() Checkpoint {
	return Checkpoint{Tick: s.tick, Seed: s.seed, Phase: s.phase, Ended: s.ended,
		Robots: append([]Robot{}, s.robots...), Walls: append([]Wall{}, s.walls...)}
}

// SetSpawn configures initial/respawn positions before the match starts.
func (s *Sim) SetSpawn(robotID uint32, pos Vec2, sector uint32) error {
	i, ok := s.index[robotID]
	if s.tick != 0 || !ok || !pos.finite() || sector >= 8 {
		return fmt.Errorf("sim: invalid spawn configuration for robot %d", robotID)
	}
	for _, wall := range s.walls {
		if overlapsWall(pos, wall) {
			return fmt.Errorf("sim: spawn overlaps wall %d", wall.ID)
		}
	}
	s.robots[i].Position, s.robots[i].SpawnPosition, s.robots[i].Sector = pos, pos, sector
	return nil
}

// ApplyInput queues only the newest sequence for the next tick. Sequence zero
// is valid initially; duplicates, older values and uint32 wrap are rejected.
// The last consumed control remains held until replaced (including a stop).
func (s *Sim) ApplyInput(robotID uint32, in *ombv1.ClientInput) bool {
	i, ok := s.index[robotID]
	if !ok || in == nil || s.ended || math.IsNaN(in.Aim) || math.IsInf(in.Aim, 0) {
		return false
	}
	r := &s.robots[i]
	if r.HasSeq && in.Seq <= r.LatestSeq {
		return false
	}
	r.PendingInput = Input{Seq: in.Seq, MoveX: max(-1000, min(1000, in.MoveX)),
		MoveY: max(-1000, min(1000, in.MoveY)), Fire: in.Fire, Aim: in.Aim,
		Dash: in.Dash, Shield: in.Shield, Interact: in.Interact}
	r.LatestSeq, r.HasSeq, r.InputPending = in.Seq, true, true
	return true
}

// Respawn is a queued hook for the future death scheduler (no death source or
// 3s scheduling is implemented here). The next tick resets to the configured
// spawn, preserving sequence/collision guards across lives.
func (s *Sim) Respawn(robotID uint32) bool {
	i, ok := s.index[robotID]
	if !ok || s.ended || s.robots[i].RespawnPending {
		return false
	}
	s.robots[i].RespawnPending = true
	return true
}

// Tick advances exactly 1/60s. The order is input -> move/collide -> emit ->
// checkpoint. Ticks after 28800 are no-ops, including checkpoint/end emission.
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
	s.consumeInputs()
	s.moveAndCollide()
	s.emit(initial)
	if s.tick%CheckpointInterval == 0 {
		if sink, ok := s.sink.(CheckpointSink); ok {
			sink.OnCheckpoint(s.Snapshot())
		}
	}
	clear(s.events) // Do not retain sink-owned event payloads between ticks.
}

func (s *Sim) consumeInputs() {
	for i := range s.robots {
		r := &s.robots[i]
		if r.RespawnPending {
			r.Position, r.Velocity, r.HP, r.Energy = r.SpawnPosition, Vec2{}, MaxHP, MaxEnergy
			r.State, r.Heading, r.Input, r.RespawnPending = Alive, 0, Input{}, false
			s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Respawn{
				Respawn: &ombv1.EvRespawn{Robot: r.ID, Sector: r.Sector}}})
		}
		if r.InputPending {
			r.Input, r.PendingInput, r.InputPending = r.PendingInput, Input{}, false
			r.Heading = r.Input.Aim
			s.consumed = append(s.consumed, consumedInput{r.ID, r.Input})
		}
	}
}

func (s *Sim) moveAndCollide() {
	for i := range s.robots {
		r := &s.robots[i]
		if r.State == Dead {
			r.Velocity = Vec2{}
			continue
		}
		direction := Vec2{float64(r.Input.MoveX) / 1000, float64(r.Input.MoveY) / 1000}
		if n := math.Hypot(direction.X, direction.Y); n > 1 {
			direction.X /= n
			direction.Y /= n
		}
		dv := Vec2{direction.X*MaxSpeed - r.Velocity.X, direction.Y*MaxSpeed - r.Velocity.Y}
		if n := math.Hypot(dv.X, dv.Y); n > Acceleration*DT {
			dv.X *= Acceleration * DT / n
			dv.Y *= Acceleration * DT / n
		}
		r.Velocity.X += dv.X
		r.Velocity.Y += dv.Y
		delta := Vec2{r.Velocity.X * DT, r.Velocity.Y * DT}
		fraction, hit := 1.0, false
		for _, wall := range s.walls {
			if t, ok := sweepWall(r.Position, delta, wall); ok && t <= fraction {
				fraction, hit = t, true
			}
		}
		r.Position.X += delta.X * fraction
		r.Position.Y += delta.Y * fraction
		if hit {
			impact := math.Hypot(r.Velocity.X, r.Velocity.Y)
			r.Velocity = Vec2{}
			if !r.HasWallHit || s.tick-r.LastWallHitTick >= WallHitInterval {
				r.LastWallHitTick, r.HasWallHit = s.tick, true
				s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_WallHit{
					WallHit: &ombv1.EvWallHit{Robot: r.ID, At: &ombv1.Vec2{X: r.Position.X, Y: r.Position.Y}, Impact: float32(impact)}}})
			}
		}
	}
}

func (s *Sim) emit(initial *Checkpoint) {
	if s.tick == CoreOpenTick {
		from := s.phase
		s.phase = ombv1.Phase_CORE_OPEN
		s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_PhaseChange{
			PhaseChange: &ombv1.EvPhaseChange{From: from, To: s.phase}}})
	}
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
	for _, ev := range s.events {
		ev.Tick = s.tick
		if s.sink != nil {
			s.sink.OnEvent(s.tick, ev)
		}
	}
}
