package sim

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"google.golang.org/protobuf/proto"
)

// Restoration here is deliberately internal: the production replay service
// owns selecting validated checkpoints and applying records in tick order.
func restoreGameplay(t *testing.T, cp Checkpoint, sink EventSink) *Sim {
	t.Helper()
	raw, err := json.Marshal(cp)
	if err != nil {
		t.Fatal(err)
	}
	var copy Checkpoint
	if err = json.Unmarshal(raw, &copy); err != nil {
		t.Fatal(err)
	}
	ids := make([]uint32, len(copy.Robots))
	for i, r := range copy.Robots {
		ids[i] = r.ID
	}
	s := NewSim(copy.Seed, ids, sink)
	s.tick, s.phase, s.ended = copy.Tick, copy.Phase, copy.Ended
	s.robots, s.walls, s.mapDef = copy.Robots, copy.Walls, copy.Map
	s.rng, s.nextProjectile = copy.RNG, copy.NextProjectile
	s.projectiles, s.cores, s.uplinks = copy.Projectiles, copy.Cores, copy.Uplinks
	s.publishView()
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
			r := &s.robots[s.index[rec.RobotID]]
			switch rec.Type {
			case "input":
				// A match_start checkpoint can already contain this first pending input.
				r.PendingInput, r.LatestSeq, r.HasSeq, r.InputPending = *rec.Input, rec.Input.Seq, true, true
			case "control":
				c := rec.Control
				r.Control.PendingScript = cloneCommands(c.Script)
				r.Control.ScriptPending = c.Script != nil || c.ScriptFailed
				r.Control.ScriptFailed = c.ScriptFailed
				r.Control.ToggleCount = c.Toggles
				r.RespawnPending = c.Respawn
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
	controls := 0
	var expected []*ombv1.ServerEvent
	for _, rec := range records {
		if rec.Type == "control" {
			controls++
		}
		if rec.Event != nil {
			expected = append(expected, rec.Event)
		}
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

func TestCheckpointDeepCopiesGameplayState(t *testing.T) {
	s, _ := uplinkSim(t)
	s.robots[0].Combat.Damagers = map[uint32]bool{2: true}
	s.uplinks[0].ReadyAt[1] = 30
	s.ApplyScriptCommands(1, ScriptCommands{Move: ptr(Vec2{1, 0}), Say: ptr("original")})
	cp := s.Snapshot()
	cp.Robots[0].Combat.Damagers[2] = false
	cp.Robots[0].Control.PendingScript.Move.X = 99
	*cp.Robots[0].Control.PendingScript.Say = "changed"
	cp.Uplinks[0].ReadyAt[1] = 99
	cp.Map.CoreRules.GroupWeights[PhaseOuterRing][0] = 99
	fresh := s.Snapshot()
	if !fresh.Robots[0].Combat.Damagers[2] || fresh.Robots[0].Control.PendingScript.Move.X != 1 || *fresh.Robots[0].Control.PendingScript.Say != "original" || fresh.Uplinks[0].ReadyAt[1] != 30 || fresh.Map.CoreRules.GroupWeights[PhaseOuterRing][0] != 1 {
		t.Fatal("checkpoint aliases live gameplay")
	}
	robot, _ := s.Robot(1)
	robot.Combat.Damagers[2] = false
	robot.Control.PendingScript.Move.X = 3
	if !reflect.DeepEqual(fresh, s.Snapshot()) {
		t.Fatal("Robot copy aliases live gameplay")
	}
}
