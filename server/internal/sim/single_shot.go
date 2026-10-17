package sim

import (
	"fmt"
	"math"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

const MaxPendingSingleShots = 4
const MaxRememberedSingleShots = 32
const SingleShotMaxAge uint32 = 30

// SingleShotIntent is detached from transport and never coalesced with held input.
type SingleShotIntent struct {
	Seq          uint32  `json:"seq"`
	Aim          float64 `json:"aim"`
	ObservedTick uint32  `json:"observed_tick"`
	Generation   uint32  `json:"generation"`
}

// SingleShotState is checkpointed, and recorded independently of coalesced input.
// Changed preserves an admission/reset between Tick and a checkpoint boundary.
type SingleShotState struct {
	Generation uint32             `json:"generation"`
	Pending    []SingleShotIntent `json:"pending,omitempty"`
	Accepted   []uint32           `json:"accepted,omitempty"`
	Changed    bool               `json:"changed,omitempty"`
}

func cloneSingleShots(state SingleShotState) SingleShotState {
	state.Pending = append([]SingleShotIntent(nil), state.Pending...)
	state.Accepted = append([]uint32(nil), state.Accepted...)
	return state
}

// admissionTick is the checkpoint boundary, or control-record tick minus one.
// Validate before restoring/iterating so corrupt recordings cannot grow the
// action lane or smuggle a non-finite/future/duplicate intent into combat.
func validateSingleShots(state SingleShotState, admissionTick uint32, control bool) error {
	if len(state.Pending) > MaxPendingSingleShots || len(state.Accepted) > MaxRememberedSingleShots || ((control || len(state.Pending) != 0) && !state.Changed) {
		return fmt.Errorf("sim: invalid discrete shot lane")
	}
	for i, seq := range state.Accepted {
		if state.Generation == 0 || (i > 0 && seq <= state.Accepted[i-1]) {
			return fmt.Errorf("sim: invalid discrete shot deduplication")
		}
	}
	for i, shot := range state.Pending {
		if !finite(shot.Aim) || state.Generation == 0 || shot.Generation != state.Generation ||
			shot.ObservedTick > admissionTick || uint64(admissionTick)+1-uint64(shot.ObservedTick) > uint64(SingleShotMaxAge) ||
			(i > 0 && shot.Seq <= state.Pending[i-1].Seq) {
			return fmt.Errorf("sim: invalid discrete shot intent")
		}
	}
	return nil
}

func validateRobotSingleShots(r Robot, version int, tick uint32) error {
	if version < 8 && (r.SingleShots.Changed || len(r.SingleShots.Pending) != 0 || len(r.SingleShots.Accepted) != 0) {
		return fmt.Errorf("sim: discrete shots require simulation version 8")
	}
	if err := validateSingleShots(r.SingleShots, tick, false); err != nil {
		return err
	}
	for _, seq := range r.SingleShots.Accepted {
		if !r.HasSeq || seq > r.LatestSeq {
			return fmt.Errorf("sim: accepted shot beyond latest input")
		}
	}
	for _, shot := range r.SingleShots.Pending {
		if !r.HasSeq || !r.InputPending || shot.Seq > r.LatestSeq || shot.Seq > r.PendingInput.Seq ||
			((r.HasConsumedSeq || r.ConsumedSeq != 0) && shot.Seq <= r.ConsumedSeq) {
			return fmt.Errorf("sim: discrete shot sequence outside pending input")
		}
	}
	return nil
}

// Accepted IDs are a bounded feedback dedup window, not a retry buffer. Pending
// requests remain covered even if a recording was made before this cache existed.
func (s *Sim) SingleShotAccepted(id, seq, generation uint32) bool {
	i, ok := s.index[id]
	if !ok || generation == 0 || s.robots[i].SingleShots.Generation != generation {
		return false
	}
	state := &s.robots[i].SingleShots
	for _, shot := range state.Pending {
		if shot.Seq == seq {
			return true
		}
	}
	for _, accepted := range state.Accepted {
		if accepted == seq {
			return true
		}
	}
	return false
}

// SingleShotFeedbackSuppressed decides feedback only, never admission. Known
// accepted IDs keep their original reliable terminal. Once the bounded cache
// is full, IDs below its oldest entry are ambiguous: they may have been accepted
// and evicted, so do not invent a conflicting sequence rejection. Unknown IDs
// within the horizon still receive sequence rejection through ApplyInputOutcome.
// Generation resets clear the cache; checkpoint/replay preserve its lower bound.
func (s *Sim) SingleShotFeedbackSuppressed(id, seq, generation uint32) bool {
	if s.SingleShotAccepted(id, seq, generation) {
		return true
	}
	i, ok := s.index[id]
	if !ok || generation == 0 || s.robots[i].SingleShots.Generation != generation {
		return false
	}
	accepted := s.robots[i].SingleShots.Accepted
	return len(accepted) == MaxRememberedSingleShots && seq < accepted[0]
}

// SetInputGeneration is owner-only. The transport owns cross-match/connection
// tokens; deterministic deaths/respawns increment the current token in Sim.
// Zero is an exhausted/disabled generation, never a valid request token.
func (s *Sim) SetInputGeneration(id, generation uint32) bool {
	i, ok := s.index[id]
	if !ok || s.simulationVersion < 8 || s.ended {
		return false
	}
	s.robots[i].SingleShots = SingleShotState{Generation: generation, Changed: true}
	return true
}

func (s *Sim) RotateInputGeneration(id uint32) bool {
	i, ok := s.index[id]
	if !ok {
		return false
	}
	return s.SetInputGeneration(id, nextInputGeneration(s.robots[i].SingleShots.Generation))
}

func nextInputGeneration(generation uint32) uint32 {
	if generation == 0 || generation == math.MaxUint32 {
		return 0
	}
	return generation + 1
}

func (s *Sim) resetLifeShots(r *Robot) {
	if s.simulationVersion < 8 {
		return
	}
	for _, shot := range r.SingleShots.Pending {
		s.singleShotResult(r.ID, shot.Seq, "cancelled")
	}
	r.SingleShots = SingleShotState{Generation: nextInputGeneration(r.SingleShots.Generation)}
}

func (s *Sim) admitSingleShot(r *Robot, seq uint32, shot *ombv1.SingleShot) string {
	if s.simulationVersion < 8 {
		return "unsupported"
	}
	if !finite(shot.Aim) {
		return "invalid_aim"
	}
	if shot.Generation == 0 || shot.Generation != r.SingleShots.Generation {
		return "generation"
	}
	if shot.ObservedTick > s.tick {
		return "future"
	}
	// Consumption is on the next boundary, not at transport admission. Tick zero
	// is a real observation early in the match, not a missing-value sentinel.
	if uint64(s.tick)+1-uint64(shot.ObservedTick) > uint64(SingleShotMaxAge) {
		return "stale"
	}
	if len(r.SingleShots.Pending) >= MaxPendingSingleShots {
		return "overflow"
	}
	r.SingleShots.Pending = append(r.SingleShots.Pending, SingleShotIntent{Seq: seq, Aim: shot.Aim, ObservedTick: shot.ObservedTick, Generation: shot.Generation})
	r.SingleShots.Accepted = append(r.SingleShots.Accepted, seq)
	if len(r.SingleShots.Accepted) > MaxRememberedSingleShots {
		copy(r.SingleShots.Accepted, r.SingleShots.Accepted[1:])
		r.SingleShots.Accepted = r.SingleShots.Accepted[:MaxRememberedSingleShots]
	}
	r.SingleShots.Changed = true
	return ""
}

func (s *Sim) singleShotResult(robot, seq uint32, outcome string) {
	s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_SingleShotResult{SingleShotResult: &ombv1.EvSingleShotResult{Robot: robot, Seq: seq, Outcome: outcome}}})
}

func (s *Sim) consumeSingleShots(r *Robot) bool {
	if s.simulationVersion < 8 || len(r.SingleShots.Pending) == 0 {
		return false
	}
	for _, shot := range r.SingleShots.Pending {
		outcome := ""
		switch {
		case !finite(shot.Aim):
			outcome = "invalid_aim"
		case shot.Generation == 0 || shot.Generation != r.SingleShots.Generation:
			outcome = "generation"
		case shot.ObservedTick >= s.tick:
			outcome = "future"
		case s.tick-shot.ObservedTick > SingleShotMaxAge:
			outcome = "stale"
		case r.State != Dead && r.Control.HumanAxes&(AxisAim|AxisFire) != AxisAim|AxisFire:
			outcome = "ownership"
		default:
			outcome = s.tryFireProjectile(r, shot.Aim)
		}
		s.singleShotResult(r.ID, shot.Seq, outcome)
	}
	r.SingleShots.Pending = nil
	return true
}
