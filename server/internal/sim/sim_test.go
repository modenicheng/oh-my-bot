package sim

import (
	"math"
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

type recordingSink struct {
	events      []*ombv1.ServerEvent
	checkpoints []Checkpoint
	initial     *Checkpoint
	inputs      []consumedInput
	inputTicks  []uint32
}

func (s *recordingSink) OnEvent(tick uint32, event *ombv1.ServerEvent) {
	if tick != event.Tick {
		panic("inconsistent event tick")
	}
	s.events = append(s.events, proto.Clone(event).(*ombv1.ServerEvent))
}
func (s *recordingSink) OnCheckpoint(state Checkpoint) { s.checkpoints = append(s.checkpoints, state) }
func (s *recordingSink) OnMatchInit(state Checkpoint)  { s.initial = &state }
func (s *recordingSink) OnInput(tick uint32, robotID uint32, in Input) {
	s.inputs = append(s.inputs, consumedInput{robotID, in})
	s.inputTicks = append(s.inputTicks, tick)
}

func advance(s *Sim, to uint32) {
	for s.CurrentTick() < to {
		s.Tick()
	}
}

func mustRobot(t *testing.T, s *Sim, id uint32) Robot {
	t.Helper()
	r, ok := s.Robot(id)
	if !ok {
		t.Fatalf("robot %d missing", id)
	}
	return r
}

func closeFloat(t *testing.T, got, want float64) {
	t.Helper()
	if math.IsNaN(got) || math.Abs(got-want) > 1e-9 {
		t.Fatalf("got %.14g, want %.14g", got, want)
	}
}

func TestTickLifecycle(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(1<<63+17, []uint32{20, 3}, sink)
	if s.CurrentTick() != 0 || s.Ended() || s.Phase() != ombv1.Phase_OUTER_RING || len(sink.events) != 0 {
		t.Fatal("constructor advanced simulation")
	}
	s.Tick()
	if len(sink.events) != 1 {
		t.Fatalf("first tick events: %v", sink.events)
	}
	start := sink.events[0].GetMatchStart()
	if start == nil || start.MapSeed != 1<<63+17 || start.Players != 2 || sink.events[0].Tick != 1 {
		t.Fatal("wrong match start")
	}
	if sink.initial == nil || sink.initial.Tick != 0 || sink.initial.Robots[0].ID != 3 {
		t.Fatal("missing canonical initial player table")
	}
	advance(s, CoreOpenTick-1)
	if len(sink.events) != 1 || s.Phase() != ombv1.Phase_OUTER_RING {
		t.Fatal("phase changed early")
	}
	s.Tick()
	if len(sink.events) != 2 || sink.events[1].Tick != 14400 || s.Phase() != ombv1.Phase_CORE_OPEN {
		t.Fatal("phase boundary wrong")
	}
	change := sink.events[1].GetPhaseChange()
	if change == nil || change.From != ombv1.Phase_OUTER_RING || change.To != ombv1.Phase_CORE_OPEN {
		t.Fatal("wrong phase event")
	}
	advance(s, MatchTicks-1)
	if s.Ended() || len(sink.events) != 2 {
		t.Fatal("match ended early")
	}
	s.Tick()
	if !s.Ended() || s.CurrentTick() != 28800 || len(sink.events) != 3 {
		t.Fatal("match end boundary wrong")
	}
	end := sink.events[2]
	if end.Tick != MatchTicks || end.GetMatchEnd() == nil || len(end.GetMatchEnd().Scores) != 0 {
		t.Fatal("wrong match end event")
	}
	before := s.Snapshot()
	for i := 0; i < 100; i++ {
		s.Tick()
	}
	if !reflect.DeepEqual(before, s.Snapshot()) || len(sink.events) != 3 || len(sink.checkpoints) != 8 {
		t.Fatal("ended match mutated")
	}
	if s.ApplyInput(3, &ombv1.ClientInput{Seq: 999}) || s.Respawn(3) {
		t.Fatal("ended match accepted commands")
	}
}

func TestApplyInputSequenceAndOwnership(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(0, []uint32{1}, sink)
	if s.ApplyInput(1, nil) || s.ApplyInput(2, &ombv1.ClientInput{}) {
		t.Fatal("invalid input accepted")
	}
	if !s.ApplyInput(1, &ombv1.ClientInput{Seq: 0, AxisMask: uint32(AxisMove), MoveX: 1000}) {
		t.Fatal("initial zero seq rejected")
	}
	newest := &ombv1.ClientInput{Seq: 5, AxisMask: uint32(AxisMove | AxisAim | AxisFire), MoveY: 1000, Aim: 1.2, Fire: true, Dash: true, Shield: true, Interact: true}
	if !s.ApplyInput(1, newest) {
		t.Fatal("new input rejected")
	}
	newest.MoveX, newest.MoveY, newest.Aim = -1000, 0, 9
	if s.ApplyInput(1, &ombv1.ClientInput{Seq: 4, MoveX: -1000}) || s.ApplyInput(1, &ombv1.ClientInput{Seq: 5}) {
		t.Fatal("stale input accepted")
	}
	if r := mustRobot(t, s, 1); r.Position != (Vec2{}) || r.Input.Seq != 0 || !r.InputPending {
		t.Fatal("input applied before tick")
	}
	s.Tick()
	r := mustRobot(t, s, 1)
	closeFloat(t, r.Velocity.X, 0)
	closeFloat(t, r.Velocity.Y, Acceleration*DT)
	closeFloat(t, r.Position.Y, Acceleration*DT*DT)
	if r.Input.Seq != 5 || r.Heading != 1.2 || r.InputPending || !r.Input.Fire || r.Input.Dash || r.Input.Shield || r.Input.Interact {
		t.Fatal("input not copied/consumed intact")
	}
	if len(sink.inputs) != 1 || sink.inputTicks[0] != 1 || sink.inputs[0].input.Seq != 5 {
		t.Fatal("log must contain consumed input only")
	}
	if s.ApplyInput(1, &ombv1.ClientInput{Seq: 2}) {
		t.Fatal("old input accepted after consumption")
	}
	s.Tick()
	closeFloat(t, mustRobot(t, s, 1).Velocity.Y, 2*Acceleration*DT)
	if len(sink.inputs) != 1 {
		t.Fatal("held input should not be re-logged")
	}
	if !s.ApplyInput(1, &ombv1.ClientInput{Seq: math.MaxUint32}) || s.ApplyInput(1, &ombv1.ClientInput{Seq: 0}) {
		t.Fatal("sequence wrap must not pass monotonic guard")
	}
	s.Tick()
	if mustRobot(t, s, 1).Input.Seq != math.MaxUint32 {
		t.Fatal("maximum sequence lost")
	}
}

func TestApplyInputValidation(t *testing.T) {
	s := NewSim(1, []uint32{1}, nil)
	for _, aim := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if s.ApplyInput(1, &ombv1.ClientInput{Seq: 10, Aim: aim}) {
			t.Fatal("nonfinite aim accepted")
		}
	}
	if !s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: math.MaxInt32, MoveY: math.MinInt32}) {
		t.Fatal("invalid input poisoned seq guard")
	}
	s.Tick()
	r := mustRobot(t, s, 1)
	if r.Input.MoveX != 1000 || r.Input.MoveY != -1000 {
		t.Fatal("input not clamped")
	}
	closeFloat(t, math.Hypot(r.Velocity.X, r.Velocity.Y), Acceleration*DT)
}

func TestMovementAccelerationSpeedAndBraking(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000, MoveY: 1000})
	previous := Vec2{}
	for i := 0; i < 100; i++ {
		s.Tick()
		r := mustRobot(t, s, 1)
		if math.Hypot(r.Velocity.X, r.Velocity.Y) > MaxSpeed+1e-12 || math.Hypot(r.Velocity.X-previous.X, r.Velocity.Y-previous.Y) > Acceleration*DT+1e-12 {
			t.Fatal("speed/acceleration exceeded")
		}
		closeFloat(t, r.Position.X, r.Position.Y)
		previous = r.Velocity
	}
	closeFloat(t, math.Hypot(previous.X, previous.Y), MaxSpeed)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove)})
	advance(s, 121)
	if r := mustRobot(t, s, 1); r.Velocity != (Vec2{}) {
		t.Fatalf("did not stop: %+v", r.Velocity)
	}
	r := mustRobot(t, s, 1)
	s.Tick()
	if mustRobot(t, s, 1).Position != r.Position {
		t.Fatal("idle drift")
	}
}

func TestCheckpointIntervalsAndIsolation(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(23, []uint32{4, 2, 3}, sink)
	s.ApplyInput(2, &ombv1.ClientInput{Seq: 9, AxisMask: uint32(AxisMove), MoveX: 1000})
	advance(s, CheckpointInterval-1)
	if len(sink.checkpoints) != 0 {
		t.Fatal("checkpoint early")
	}
	advance(s, MatchTicks)
	if len(sink.checkpoints) != 8 {
		t.Fatalf("checkpoints: %d", len(sink.checkpoints))
	}
	for i, cp := range sink.checkpoints {
		if cp.Tick != uint32(i+1)*CheckpointInterval || cp.Seed != 23 || len(cp.Robots) != 3 || cp.Walls == nil {
			t.Fatalf("bad checkpoint %d: %+v", i, cp)
		}
		if cp.Robots[0].ID != 2 || cp.Robots[0].Input.Seq != 9 || !cp.Robots[0].HasSeq || cp.Robots[0].LatestSeq != 9 {
			t.Fatal("incomplete checkpoint")
		}
		if cp.Ended != (cp.Tick == MatchTicks) {
			t.Fatal("checkpoint precedes lifecycle events")
		}
		wantPhase := ombv1.Phase_OUTER_RING
		if cp.Tick >= CoreOpenTick {
			wantPhase = ombv1.Phase_CORE_OPEN
		}
		if cp.Phase != wantPhase {
			t.Fatal("checkpoint phase not current")
		}
	}
	if sink.checkpoints[0].Robots[0].Position == sink.checkpoints[7].Robots[0].Position {
		t.Fatal("checkpoint aliases live state")
	}
	sink.checkpoints[7].Robots[0].HP = -500
	if mustRobot(t, s, 2).HP != MaxHP {
		t.Fatal("sink mutated live robot")
	}
}

func TestRespawnHook(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(1, []uint32{1}, sink)
	if err := s.SetSpawn(1, Vec2{2, 3}, 5); err != nil {
		t.Fatal(err)
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 7, AxisMask: uint32(AxisMove), MoveX: 1000})
	s.Tick()
	s.robots[0].HP, s.robots[0].Energy, s.robots[0].State = 0, 20, Dead // Future damage system.
	s.Tick()
	if mustRobot(t, s, 1).Velocity != (Vec2{}) {
		t.Fatal("dead robot moved")
	}
	if !s.Respawn(1) || s.Respawn(1) || s.Respawn(9) {
		t.Fatal("respawn queue validation")
	}
	if mustRobot(t, s, 1).HP != 0 {
		t.Fatal("respawn applied outside tick")
	}
	s.Tick()
	r := mustRobot(t, s, 1)
	if r.Position != (Vec2{2, 3}) || r.HP != MaxHP || r.Energy != MaxEnergy || r.State != Alive || r.RespawnPending || r.LatestSeq != 7 {
		t.Fatalf("bad respawn: %+v", r)
	}
	ev := sink.events[len(sink.events)-1]
	if ev.Tick != 3 || ev.GetRespawn() == nil || ev.GetRespawn().Robot != 1 || ev.GetRespawn().Sector != 5 {
		t.Fatal("bad respawn event")
	}
}

func TestConstructorAndSnapshotOwnership(t *testing.T) {
	for _, ids := range [][]uint32{{0}, {1, 1}} {
		t.Run("invalid_ids", func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("invalid IDs did not panic")
				}
			}()
			NewSim(0, ids, nil)
		})
	}
	ids := []uint32{9, 1}
	s := NewSim(0, ids, nil)
	ids[0] = 0
	cp := s.Snapshot()
	cp.Robots[0].HP = -1
	if mustRobot(t, s, 1).HP != MaxHP || mustRobot(t, s, 9).ID != 9 {
		t.Fatal("caller owns live data")
	}
	if _, ok := s.Robot(0); ok {
		t.Fatal("unknown robot exists")
	}
	empty := NewSim(0, nil, nil)
	empty.Tick()
	if empty.Snapshot().Robots == nil || empty.CurrentTick() != 1 {
		t.Fatal("empty roster unsupported")
	}
}

func TestDeterministicOrdering(t *testing.T) {
	a, b := &recordingSink{}, &recordingSink{}
	x, y := NewSim(123, []uint32{3, 1, 2}, a), NewSim(123, []uint32{2, 3, 1}, b)
	for _, s := range []*Sim{x, y} {
		for _, id := range []uint32{3, 2, 1} {
			s.ApplyInput(id, &ombv1.ClientInput{Seq: id, AxisMask: uint32(AxisMove), MoveX: int32(id) * 100})
		}
		advance(s, MatchTicks)
	}
	if !reflect.DeepEqual(x.Snapshot(), y.Snapshot()) || len(a.events) != len(b.events) {
		t.Fatal("simulation ordering nondeterministic")
	}
	for i := range a.events {
		if !proto.Equal(a.events[i], b.events[i]) {
			t.Fatalf("event %d differs", i)
		}
	}
	if !reflect.DeepEqual(a.checkpoints, b.checkpoints) {
		t.Fatal("checkpoint stream nondeterministic")
	}
}

func BenchmarkTick64Robots(b *testing.B) {
	ids := make([]uint32, 64)
	for i := range ids {
		ids[i] = uint32(i + 1)
	}
	s := NewSim(1, ids, nil)
	for _, id := range ids {
		s.ApplyInput(id, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000, MoveY: 500})
	}
	s.Tick()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if s.ended {
			s.tick, s.ended, s.phase = 1, false, ombv1.Phase_OUTER_RING
		}
		s.Tick()
	}
}
