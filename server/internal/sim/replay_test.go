package sim

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func TestReplayVisualFramesAdvanceBetweenCheckpoints(t *testing.T) {
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(7, []uint32{1}, log)
	if err := s.SetMap(gameMap()); err != nil {
		t.Fatal(err)
	}
	for tick := uint32(1); tick <= 120; tick++ {
		if tick == 1 || tick == 120 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: tick, AxisMask: uint32(AxisMove), MoveX: 1000})
		}
		s.Tick()
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	frames, err := ReplayVisualFrames(bytes.NewReader(buf.Bytes()), 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 41 || frames[0].Tick != 0 || frames[len(frames)-1].Tick != 120 {
		t.Fatalf("unexpected visual samples: len=%d first=%d last=%d", len(frames), frames[0].Tick, frames[len(frames)-1].Tick)
	}
	if frames[1].Robots[0].Pos == frames[20].Robots[0].Pos || frames[20].Robots[0].Pos == frames[len(frames)-1].Robots[0].Pos {
		t.Fatal("visual replay did not advance robot position between checkpoints")
	}
	want := s.WorldView()
	got := frames[len(frames)-1]
	if got.Robots[0].Pos != want.Robots[0].Pos || got.Robots[0].Heading != want.Robots[0].Turret {
		t.Fatalf("final visual sample differs: got=%+v want=%+v", got.Robots[0], want.Robots[0])
	}
}

func TestReplayToUsesProductionCheckpointsAndControls(t *testing.T) {
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(33, []uint32{1, 2}, log)
	if err := s.SetMap(gameMap()); err != nil {
		t.Fatal(err)
	}
	wanted := map[uint32]Checkpoint{}
	for tick := uint32(1); tick <= CoreOpenTick+240; tick++ {
		if tick == 1 {
			s.AssistToggle(2)
			s.ApplyScriptCommands(2, ScriptCommands{Move: ptr(Vec2{0, 1})})
			s.Say(1, "initial pending")
		}
		if tick == CheckpointInterval+1 || tick == CoreOpenTick+1 {
			s.AssistToggle(2)
			s.ApplyInput(1, &ombv1.ClientInput{Seq: tick, AxisMask: uint32(AxisMove), MoveX: 1000})
		}
		if tick == CoreOpenTick+100 {
			s.Say(1, "target coverage")
		}
		s.Tick()
		if tick == 1 || tick == CheckpointInterval || tick == CheckpointInterval+120 || tick == CoreOpenTick+100 {
			wanted[tick] = s.Snapshot()
		}
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	for tick, want := range wanted {
		sink := &recordingSink{}
		replayed, err := ReplayTo(bytes.NewReader(buf.Bytes()), tick, sink)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		if !reflect.DeepEqual(want, replayed.Snapshot()) {
			t.Fatalf("production replay differs at tick %d", tick)
		}
		if tick == 1 {
			r, _ := replayed.Robot(2)
			if !r.Control.Assist {
				t.Fatal("initial pending assist was toggled twice")
			}
		}
		if tick == CheckpointInterval+120 && len(sink.checkpoints) != 0 {
			t.Fatal("replay ignored nearest checkpoint")
		}
	}
}

func TestRestoreCheckpointDetachesAndRejectsInvalidState(t *testing.T) {
	s := NewSim(4, []uint32{1, 2}, nil)
	def := gameMap()
	def.CorePads = []CorePadDef{{ID: 11, Pos: Vec2{20, 0}, Group: 0, Value: 10}}
	if err := s.SetMap(def); err != nil {
		t.Fatal(err)
	}
	s.AssistToggle(1)
	s.ApplyScriptCommands(1, ScriptCommands{Move: ptr(Vec2{1, 0})})
	cp := s.Snapshot()
	restored, err := RestoreCheckpoint(cp, nil)
	if err != nil {
		t.Fatal(err)
	}
	cp.Robots[0].Control.PendingScript.Move.X = -1
	cp.Robots[0].Combat.DamageBy = map[uint32]float64{2: 12}
	cp.Map.CoreRules.GroupWeights[PhaseOuterRing][0] = 0
	if !reflect.DeepEqual(s.Snapshot(), restored.Snapshot()) {
		t.Fatal("restored checkpoint aliases caller memory")
	}
	for name, corrupt := range map[string]func(*Checkpoint){
		"robot identity": func(c *Checkpoint) { c.Robots[1].ID = c.Robots[0].ID },
		"version":        func(c *Checkpoint) { c.SimulationVersion = SimulationVersion + 1 },
		"nonfinite":      func(c *Checkpoint) { c.Robots[0].Position.X = math.NaN() },
		"ended":          func(c *Checkpoint) { c.Ended = true },
		"phase":          func(c *Checkpoint) { c.Phase = ombv1.Phase_PHASE_UNSPECIFIED },
		"core geometry":  func(c *Checkpoint) { c.Cores[0].Pos.X++ },
		"core rules":     func(c *Checkpoint) { c.Map.CoreRules.PeriodTicks = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			cp := s.Snapshot()
			corrupt(&cp)
			if _, err := RestoreCheckpoint(cp, nil); err == nil {
				t.Fatal("invalid checkpoint accepted")
			}
		})
	}
}

func TestRestoreCheckpointRejectsNilUplinkCooldownMap(t *testing.T) {
	s, _ := uplinkSim(t)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
	stepTicks(s, HackDuration-1)
	cp := s.Snapshot()
	cp.Uplinks[0].ReadyAt = nil
	if _, err := RestoreCheckpoint(cp, nil); err == nil {
		t.Fatal("nil cooldown map accepted before hack completion")
	}
}

func TestRestoreCheckpointRejectsPhaseTickMismatch(t *testing.T) {
	for _, tick := range []uint32{0, CoreOpenTick - 1, CoreOpenTick, MatchTicks} {
		cp := NewSim(1, []uint32{1}, nil).Snapshot()
		cp.Tick, cp.Ended = tick, tick == MatchTicks
		cp.Phase = ombv1.Phase_CORE_OPEN
		if tick >= CoreOpenTick {
			cp.Phase = ombv1.Phase_OUTER_RING
		}
		if _, err := RestoreCheckpoint(cp, nil); err == nil {
			t.Fatalf("incorrect phase accepted at tick %d", tick)
		}
	}
}

func TestReplayToRejectsDiscontinuousCheckpointAndSkippedControls(t *testing.T) {
	for name, corrupt := range map[string]func(*Checkpoint){
		"seed":     func(cp *Checkpoint) { cp.Seed++ },
		"physics":  func(cp *Checkpoint) { cp.SimulationVersion = 0 },
		"roster":   func(cp *Checkpoint) { cp.Robots[0].ID = 2 },
		"identity": func(cp *Checkpoint) { cp.Robots[0].Nick = "different" },
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			log, _ := NewMatchEventLogWriter(&buf)
			s := NewSim(1, []uint32{1}, nil)
			log.OnMatchInit(s.Snapshot())
			stepTicks(s, CheckpointInterval)
			cp := s.Snapshot()
			corrupt(&cp)
			log.OnCheckpoint(cp)
			if err := log.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := ReplayTo(bytes.NewReader(buf.Bytes()), CheckpointInterval, nil); err == nil {
				t.Fatal("unrelated checkpoint accepted")
			}
		})
	}
	var buf bytes.Buffer
	log, _ := NewMatchEventLogWriter(&buf)
	s := NewSim(1, []uint32{1}, nil)
	log.OnMatchInit(s.Snapshot())
	log.OnInput(1, 99, Input{})
	stepTicks(s, CheckpointInterval)
	log.OnCheckpoint(s.Snapshot())
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := ReplayTo(bytes.NewReader(buf.Bytes()), CheckpointInterval, nil); err == nil {
		t.Fatal("checkpoint seeking hid unknown earlier robot")
	}
}

func TestReplayToPreservesInitialPendingInput(t *testing.T) {
	var buf bytes.Buffer
	log, _ := NewMatchEventLogWriter(&buf)
	s := NewSim(1, []uint32{1}, log)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 10, AxisMask: uint32(AxisMove), MoveX: 1000})
	s.Tick()
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := ReplayTo(bytes.NewReader(buf.Bytes()), 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.Snapshot(), r.Snapshot()) {
		t.Fatal("matching pending input was rejected or applied twice")
	}
}

func TestReplayToRejectsInputSequenceRegression(t *testing.T) {
	for _, next := range []uint32{9, 10} {
		var buf bytes.Buffer
		log, _ := NewMatchEventLogWriter(&buf)
		log.OnMatchInit(NewSim(1, []uint32{1}, nil).Snapshot())
		log.OnInput(1, 1, Input{Seq: 10, AxisMask: AxisMove, MoveX: 1000})
		log.OnInput(2, 1, Input{Seq: next, AxisMask: AxisMove, MoveX: -1000})
		if err := log.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := ReplayTo(bytes.NewReader(buf.Bytes()), 2, nil); err == nil {
			t.Fatalf("sequence %d accepted after 10", next)
		}
		var seek bytes.Buffer
		seekLog, _ := NewMatchEventLogWriter(&seek)
		s := NewSim(1, []uint32{1}, nil)
		seekLog.OnMatchInit(s.Snapshot())
		seekLog.OnInput(1, 1, Input{Seq: 10})
		seekLog.OnInput(2, 1, Input{Seq: next})
		stepTicks(s, CheckpointInterval)
		s.robots[0].HasSeq, s.robots[0].LatestSeq, s.robots[0].ConsumedSeq = true, next, next
		seekLog.OnCheckpoint(s.Snapshot())
		if err := seekLog.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := ReplayTo(bytes.NewReader(seek.Bytes()), CheckpointInterval, nil); err == nil {
			t.Fatalf("checkpoint seeking hid sequence %d after 10", next)
		}
	}
}

func TestReplayToRejectsUnknownRobotsAndMissingCoverage(t *testing.T) {
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(42, []uint32{1}, nil)
	log.OnMatchInit(s.Snapshot())
	log.OnInput(1, 99, Input{})
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := ReplayTo(bytes.NewReader(buf.Bytes()), 1, nil); err == nil {
		t.Fatal("unknown robot controls accepted")
	}
	if _, err := ReplayTo(bytes.NewReader(buf.Bytes()), 2, nil); err == nil {
		t.Fatal("replay extrapolated past recorded coverage")
	}
	if _, err := ReplayTo(bytes.NewReader(buf.Bytes()), MatchTicks+1, nil); err == nil {
		t.Fatal("replay advanced past match end")
	}
	headerOnly := []byte("{\"schema_version\":1}\n")
	if _, err := ReplayTo(bytes.NewReader(headerOnly), 0, nil); err == nil {
		t.Fatal("missing initial checkpoint accepted")
	}
	cp, err := json.Marshal(s.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	duplicate := append(headerOnly, []byte("{\"type\":\"match_start\",\"tick\":0,\"state\":"+string(cp)+"}\n{\"type\":\"match_start\",\"tick\":0,\"state\":"+string(cp)+"}\n")...)
	if _, err := ReplayTo(bytes.NewReader(duplicate), 0, nil); err == nil {
		t.Fatal("duplicate bootstrap accepted")
	}
}
