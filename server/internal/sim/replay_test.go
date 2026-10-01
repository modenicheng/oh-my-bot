package sim

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

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
	cp.Robots[0].Combat.Damagers = map[uint32]bool{2: true}
	cp.Map.CoreRules.GroupWeights[PhaseOuterRing][0] = 0
	if !reflect.DeepEqual(s.Snapshot(), restored.Snapshot()) {
		t.Fatal("restored checkpoint aliases caller memory")
	}
	for name, corrupt := range map[string]func(*Checkpoint){
		"robot identity":  func(c *Checkpoint) { c.Robots[1].ID = c.Robots[0].ID },
		"version":         func(c *Checkpoint) { c.SimulationVersion = SimulationVersion + 1 },
		"nonfinite":       func(c *Checkpoint) { c.Robots[0].Position.X = math.NaN() },
		"ended":           func(c *Checkpoint) { c.Ended = true },
		"phase":           func(c *Checkpoint) { c.Phase = ombv1.Phase_PHASE_UNSPECIFIED },
		"core geometry":   func(c *Checkpoint) { c.Cores[0].Pos.X++ },
		"core rules":      func(c *Checkpoint) { c.Map.CoreRules.PeriodTicks = 0 },
		"unknown partner": func(c *Checkpoint) { c.Robots[0].Combat.Partner = 99 },
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
