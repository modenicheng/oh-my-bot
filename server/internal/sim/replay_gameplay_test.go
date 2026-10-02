package sim

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func restoreGameplay(t *testing.T, cp Checkpoint, sink EventSink) *Sim {
	t.Helper()
	s, err := RestoreCheckpoint(cp, sink)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func replayGameplay(t *testing.T, s *Sim, records []LogRecord, until uint32) {
	t.Helper()
	start := s.tick
	byTick := make(map[uint32][]LogRecord)
	for _, rec := range records {
		if rec.Tick > start && (rec.Type == "input" || rec.Type == "control") {
			byTick[rec.Tick] = append(byTick[rec.Tick], rec)
		}
	}
	for s.tick < until {
		for _, rec := range byTick[s.tick+1] {
			if err := s.applyReplayRecord(rec); err != nil {
				t.Fatal(err)
			}
		}
		s.Tick()
	}
}

func TestGameplayLogAndCheckpointReplay(t *testing.T) {
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(145, []uint32{1, 2, 3, 4}, log)
	m := gameMap()
	m.CorePads = []CorePadDef{{ID: 100, Pos: Vec2{20, 0}, Value: 10, Group: 0}, {ID: 101, Pos: Vec2{}, Value: 25, Group: 1}}
	m.Uplinks = []UplinkDef{{ID: 102, Pos: Vec2{20, 0}, InteractR: 2.5, ActivePhase: PhaseOuterRing}}
	if err = s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	if err = s.SetSpawn(1, Vec2{20, 0}, 0); err != nil {
		t.Fatal(err)
	}
	var middle Checkpoint
	for tick := uint32(1); tick <= 900; tick++ {
		if tick == 1 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Interact: true})
		}
		if tick%15 == 0 {
			s.ApplyScriptCommands(2, ScriptCommands{Fire: ptr(true), Aim: ptr(float64(tick) / 100), Say: ptr("test"), PulseScan: true})
		}
		if tick == 250 || tick == 300 {
			s.AssistToggle(2)
		}
		if tick == 120 || tick == 650 {
			if !s.Say(3, "manual replay") {
				t.Fatal("manual say rejected")
			}
		}
		if tick == 305 {
			s.ClearScriptAxes(2)
		}
		if tick == 500 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisAbility | AxisMove), MoveX: 500, Dash: true})
		}
		if tick == 550 {
			s.Respawn(1)
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 3, AxisMask: uint32(AxisFire), Fire: true})
		}
		s.Tick()
		if tick == 450 {
			if !s.Say(3, "pending checkpoint") {
				t.Fatal("pending checkpoint say rejected")
			}
			middle = s.Snapshot()
		}
	}
	if err = log.Flush(); err != nil {
		t.Fatal(err)
	}
	records, err := ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) == 0 || records[0].Type != "match_start" {
		t.Fatal("missing initial state")
	}
	controls, manual := 0, 0
	var expected []*ombv1.ServerEvent
	for _, rec := range records {
		if rec.Type == "control" {
			controls++
			if rec.Control.Say != "" {
				manual++
			}
		}
		if rec.Event != nil {
			expected = append(expected, rec.Event)
		}
	}
	if manual != 3 {
		t.Fatalf("manual say records: %d", manual)
	}
	if middle.Robots[2].Control.PendingSay != "pending checkpoint" {
		t.Fatal("checkpoint lost pending say")
	}
	if controls < 60 {
		t.Fatalf("missing gameplay controls: %d", controls)
	}
	for _, cp := range []Checkpoint{*records[0].State, middle} {
		sink := &recordingSink{}
		replay := restoreGameplay(t, cp, sink)
		replayGameplay(t, replay, records, 900)
		wantRaw, _ := json.Marshal(s.Snapshot())
		gotRaw, _ := json.Marshal(replay.Snapshot())
		if !bytes.Equal(wantRaw, gotRaw) {
			t.Fatalf("gameplay state diverged from checkpoint tick %d\nwant %s\ngot %s", cp.Tick, wantRaw, gotRaw)
		}
		want := []*ombv1.ServerEvent{}
		for _, ev := range expected {
			if ev.Tick > cp.Tick {
				want = append(want, ev)
			}
		}
		if len(want) != len(sink.events) {
			t.Fatalf("event count from tick %d: %d vs %d", cp.Tick, len(want), len(sink.events))
		}
		for i := range want {
			if !proto.Equal(want[i], sink.events[i]) {
				t.Fatalf("event mismatch from tick %d at event %d", cp.Tick, i)
			}
		}
	}
}

func TestWholeMatchReplayFromInitialAndMidpoint(t *testing.T) {
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(77, []uint32{1, 2}, log)
	if err := s.SetMap(gameMap()); err != nil {
		t.Fatal(err)
	}
	for tick := uint32(1); tick <= MatchTicks; tick++ {
		switch tick {
		case 1:
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveX: 1000})
		case 122:
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove), MoveY: -1000})
		case 420:
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 3, AxisMask: uint32(AxisMove)})
		case CoreOpenTick + 10:
			s.ApplyScriptCommands(2, ScriptCommands{Move: ptr(Vec2{0, 1}), Fire: ptr(true)})
		case CoreOpenTick + 90:
			s.ClearScriptAxes(2)
		}
		if tick == 240 || tick == CoreOpenTick+120 {
			if !s.Say(1, "whole match") {
				t.Fatal("say rejected")
			}
		}
		s.Tick()
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) == 0 || records[0].Type != "match_start" {
		t.Fatal("missing initial state")
	}
	var middle *Checkpoint
	var expected []*ombv1.ServerEvent
	phaseChanges, controls, checkpoints := 0, 0, 0
	for _, rec := range records {
		if rec.Type == "checkpoint" {
			checkpoints++
			if rec.Tick == CoreOpenTick {
				middle = rec.State
			}
		}
		if rec.Type == "control" {
			controls++
		}
		if rec.Event != nil {
			expected = append(expected, rec.Event)
			if rec.Event.GetPhaseChange() != nil {
				phaseChanges++
			}
		}
	}
	if middle == nil || checkpoints != int(MatchTicks/CheckpointInterval) || phaseChanges != 1 || controls < 4 || expected[len(expected)-1].GetMatchEnd() == nil {
		t.Fatalf("incomplete match log: midpoint=%t checkpoints=%d phase=%d controls=%d", middle != nil, checkpoints, phaseChanges, controls)
	}
	want, err := json.Marshal(s.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	for _, cp := range []Checkpoint{*records[0].State, *middle} {
		sink := &recordingSink{}
		replay := restoreGameplay(t, cp, sink)
		replayGameplay(t, replay, records, MatchTicks)
		got, err := json.Marshal(replay.Snapshot())
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(want, got) {
			t.Fatalf("whole-match state diverged from checkpoint tick %d", cp.Tick)
		}
		index := 0
		for _, ev := range expected {
			if ev.Tick <= cp.Tick {
				continue
			}
			if index >= len(sink.events) || !proto.Equal(ev, sink.events[index]) {
				t.Fatalf("whole-match event mismatch from tick %d at index %d", cp.Tick, index)
			}
			index++
		}
		if index != len(sink.events) {
			t.Fatalf("whole-match replay from tick %d emitted %d events, want %d", cp.Tick, len(sink.events), index)
		}
	}
}

func TestCheckpointDeepCopiesGameplayState(t *testing.T) {
	s, _ := uplinkSim(t)
	s.robots[0].Combat.DamageBy = map[uint32]float64{2: 12}
	s.uplinks[0].ReadyAt[1] = 30
	s.ApplyScriptCommands(1, ScriptCommands{Move: ptr(Vec2{1, 0}), Say: ptr("original")})
	if !s.Say(1, "pending") {
		t.Fatal("manual say rejected")
	}
	cp := s.Snapshot()
	cp.Robots[0].Control.PendingSay = "changed"
	cp.Robots[0].Combat.DamageBy[2] = 0
	cp.Robots[0].Control.PendingScript.Move.X = 99
	*cp.Robots[0].Control.PendingScript.Say = "changed"
	cp.Uplinks[0].ReadyAt[1] = 99
	cp.Map.CoreRules.GroupWeights[PhaseOuterRing][0] = 99
	fresh := s.Snapshot()
	if fresh.Robots[0].Control.PendingSay != "pending" || fresh.Robots[0].Combat.DamageBy[2] != 12 || fresh.Robots[0].Control.PendingScript.Move.X != 1 || *fresh.Robots[0].Control.PendingScript.Say != "original" || fresh.Uplinks[0].ReadyAt[1] != 30 || fresh.Map.CoreRules.GroupWeights[PhaseOuterRing][0] != 1 {
		t.Fatal("checkpoint aliases live gameplay")
	}
	robot, _ := s.Robot(1)
	robot.Combat.DamageBy[2] = 0
	robot.Control.PendingScript.Move.X = 3
	if !reflect.DeepEqual(fresh, s.Snapshot()) {
		t.Fatal("Robot copy aliases live gameplay")
	}
}
