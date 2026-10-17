package sim

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func shotInput(s *Sim, seq uint32, aim float64) *ombv1.ClientInput {
	r, _ := s.Robot(1)
	return &ombv1.ClientInput{Seq: seq, SingleShot: &ombv1.SingleShot{Aim: aim, ObservedTick: s.CurrentTick(), Generation: r.SingleShots.Generation}}
}

func TestSingleShotSurvivesCoalescingAndCapturesHeading(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	if !s.ApplyInput(1, shotInput(s, 1, math.Pi/2)) {
		t.Fatal("shot rejected")
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisAim | AxisFire), Aim: -1})
	s.Tick()
	if len(s.projectiles) != 1 || s.projectiles[0].BaseHeading != math.Pi/2 {
		t.Fatalf("lost or bent captured shot: %+v", s.projectiles)
	}
	r, _ := s.Robot(1)
	if r.ConsumedSeq != 2 || r.Control.HumanAxes&(AxisAim|AxisFire) != AxisAim|AxisFire || r.Control.Human.Fire {
		t.Fatalf("shot must atomically own human aim/fire, preserve ack: %+v", r)
	}
	for range FireInterval + 2 {
		s.Tick()
	}
	if s.nextProjectile != 3 {
		t.Fatal("discrete shot retried")
	}
}

func TestSingleShotAdmissionValidationAndBound(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*ombv1.ClientInput)
	}{
		{"nan", func(in *ombv1.ClientInput) { in.SingleShot.Aim = math.NaN() }},
		{"infinite", func(in *ombv1.ClientInput) { in.SingleShot.Aim = math.Inf(1) }},
		{"generation", func(in *ombv1.ClientInput) { in.SingleShot.Generation++ }},
		{"future", func(in *ombv1.ClientInput) { in.SingleShot.ObservedTick++ }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := NewSim(42, []uint32{1}, nil)
			in := shotInput(s, 1, 0)
			tc.edit(in)
			if s.ApplyInput(1, in) {
				t.Fatal("invalid shot admitted")
			}
			s.Tick()
			if len(s.projectiles) != 0 {
				t.Fatal("invalid shot fired")
			}
		})
	}
	s := NewSim(42, []uint32{1}, nil)
	for seq := uint32(1); seq <= 4; seq++ {
		if !s.ApplyInput(1, shotInput(s, seq, 0)) {
			t.Fatal("lane rejected before capacity")
		}
	}
	if s.ApplyInput(1, shotInput(s, 5, 0)) || s.ApplyInput(1, shotInput(s, 4, 0)) {
		t.Fatal("overflow/duplicate admitted")
	}
	r, _ := s.Robot(1)
	if len(r.SingleShots.Pending) != 4 {
		t.Fatal("lane not bounded to four")
	}
	s.Tick()
	if len(s.projectiles) != 1 {
		t.Fatal("batch bypassed fire interval")
	}
}

func TestSingleShotAgeAtNextTickBoundary(t *testing.T) {
	for _, age := range []uint32{29, 30, 31} {
		s := NewSim(42, []uint32{1}, nil)
		for range 40 {
			s.Tick()
		}
		in := shotInput(s, 1, 0)
		in.SingleShot.ObservedTick -= age
		accepted := s.ApplyInput(1, in)
		s.Tick()
		if accepted != (age == 29) || (len(s.projectiles) == 1) != (age == 29) {
			t.Fatalf("age %d: admission=%v projectiles=%d", age, accepted, len(s.projectiles))
		}
	}
}

func TestSingleShotEligibilityIsTerminalAndShared(t *testing.T) {
	for _, outcome := range []string{"cooldown", "energy", "shield", "projectile_capacity", "dead"} {
		t.Run(outcome, func(t *testing.T) {
			var buf bytes.Buffer
			log, _ := NewMatchEventLogWriter(&buf)
			s := NewSim(42, []uint32{1}, log)
			s.ApplyInput(1, shotInput(s, 1, 0))
			switch outcome {
			case "cooldown":
				s.robots[0].Combat.FireReady = 3
			case "energy":
				s.robots[0].Energy = 0
			case "shield":
				s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisAbility), Shield: true})
			case "projectile_capacity":
				s.nextProjectile = 0
			case "dead":
				s.robots[0].State = Dead
			}
			s.Tick()
			log.Flush()
			records, err := ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, rec := range records {
				if result := rec.Event.GetSingleShotResult(); result != nil {
					found = result.Robot == 1 && result.Seq == 1 && result.Outcome == outcome
				}
			}
			if !found {
				t.Fatalf("missing terminal %s", outcome)
			}
			for range FireInterval + 4 {
				s.Tick()
			}
			if len(s.projectiles) != 0 {
				t.Fatal("ineligible shot retried")
			}
		})
	}
}

func TestSingleShotTakesPrecedenceOverHeldAndScriptFire(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	s.SetAssist(1, true)
	s.ApplyScriptCommands(1, ScriptCommands{Aim: ptr(-1.0), Fire: ptr(true)})
	in := shotInput(s, 1, 1.0)
	in.Fire = true
	s.ApplyInput(1, in)
	s.Tick()
	if len(s.projectiles) != 1 || s.projectiles[0].BaseHeading != 1 {
		t.Fatal("discrete arbitration failed")
	}
	r, _ := s.Robot(1)
	if r.Control.Output.Fire || r.Control.Output.FireSrc != 'H' {
		t.Fatal("script/held fire bypassed human release")
	}
}

func TestSingleShotBreaksSpawnProtectionLikeHeldFire(t *testing.T) {
	for _, ready := range []uint32{0, 100} {
		s := NewSim(42, []uint32{1}, nil)
		s.Respawn(1)
		s.Tick()
		s.robots[0].Combat.FireReady = ready
		if !s.ApplyInput(1, shotInput(s, 1, 0)) {
			t.Fatal("shot rejected")
		}
		s.Tick()
		if s.robots[0].Combat.Invulnerable || s.robots[0].Combat.InvulnUntil != 0 {
			t.Fatal("single shot retained spawn protection")
		}
	}
}

func TestSingleShotLifecycleClearsPendingAndRotatesGeneration(t *testing.T) {
	s := NewSim(42, []uint32{1, 2}, nil)
	old := shotInput(s, 1, 0)
	s.ApplyInput(1, old)
	s.Respawn(1)
	s.Tick()
	r, _ := s.Robot(1)
	if len(s.projectiles) != 0 || r.SingleShots.Generation == old.SingleShot.Generation || len(r.SingleShots.Pending) != 0 {
		t.Fatal("respawn retained shot/life generation")
	}
	old.Seq = 2
	if s.ApplyInput(1, old) {
		t.Fatal("previous life accepted")
	}
	if !s.ApplyInput(1, shotInput(s, 3, 0)) {
		t.Fatal("fresh life shot rejected")
	}
	s.RotateInputGeneration(1)
	s.Tick()
	if len(s.projectiles) != 0 {
		t.Fatal("connection reset retained shot")
	}
	before, _ := s.Robot(1)
	s.robots[0].Combat.Invulnerable = false
	s.damage(2, &s.robots[0], MaxHP)
	after, _ := s.Robot(1)
	if before.SingleShots.Generation == after.SingleShots.Generation {
		t.Fatal("death did not rotate")
	}
}

func TestSingleShotCheckpointAndLogReplay(t *testing.T) {
	var buf bytes.Buffer
	log, _ := NewMatchEventLogWriter(&buf)
	s := NewSim(42, []uint32{1}, log)
	for tick := uint32(1); tick <= 70; tick++ {
		if tick == 2 || tick == 3 || tick == 40 {
			if !s.ApplyInput(1, shotInput(s, tick*2, float64(tick)/10)) {
				t.Fatal("shot not admitted")
			}
			s.ApplyInput(1, &ombv1.ClientInput{Seq: tick*2 + 1, AxisMask: uint32(AxisAim), Aim: -1})
		}
		if tick == 30 {
			s.RotateInputGeneration(1)
		}
		s.Tick()
	}
	// Force target coverage without manufacturing an extra event.
	s.Say(1, "coverage")
	s.Tick()
	log.Flush()
	replayed, err := ReplayTo(bytes.NewReader(buf.Bytes()), s.CurrentTick(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.Snapshot(), replayed.Snapshot()) {
		t.Fatal("log replay diverged")
	}
	in := shotInput(s, 500, 1)
	s.ApplyInput(1, in)
	checkpoint := s.Snapshot()
	resumed, err := RestoreCheckpoint(checkpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.Tick()
	resumed.Tick()
	if !reflect.DeepEqual(s.Snapshot(), resumed.Snapshot()) {
		t.Fatal("pending checkpoint diverged")
	}
}

func TestSingleShotRejectionStopsHeldFireAndConsumesSequence(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisFire), Fire: true})
	s.Tick()
	in := shotInput(s, 2, 0)
	in.SingleShot.Generation++
	if s.ApplyInput(1, in) {
		t.Fatal("wrong generation admitted")
	}
	for range FireInterval + 2 {
		s.Tick()
	}
	if s.nextProjectile != 3 {
		t.Fatal("rejected release retained held fire")
	}
	in.SingleShot.Generation--
	in.SingleShot.ObservedTick = s.CurrentTick()
	if s.ApplyInput(1, in) {
		t.Fatal("rejected identity retried")
	}
}

func TestSingleShotMalformedEnvelopeCannotReuseTerminalSequence(t *testing.T) {
	for _, malformed := range []func(*ombv1.ClientInput){
		func(in *ombv1.ClientInput) { in.Aim = math.NaN() },
		func(in *ombv1.ClientInput) { in.AxisMask = 128 },
	} {
		s := NewSim(42, []uint32{1}, nil)
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisFire), Fire: true})
		s.Tick()
		in := shotInput(s, 2, 0)
		malformed(in)
		if outcome := s.ApplyInputOutcome(1, in); outcome != "invalid_input" {
			t.Fatalf("outcome=%s", outcome)
		}
		for range FireInterval + 2 {
			s.Tick()
		}
		if s.nextProjectile != 3 {
			t.Fatal("malformed release retained held fire")
		}
		in = shotInput(s, 2, 0)
		if s.ApplyInput(1, in) {
			t.Fatal("malformed terminal sequence retried")
		}
	}
}

func TestSingleShotValidationOfCheckpointAndControl(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*SingleShotState)
	}{
		{"overflow", func(state *SingleShotState) {
			state.Pending = append(state.Pending, state.Pending[0], state.Pending[0], state.Pending[0], state.Pending[0])
		}},
		{"nan", func(state *SingleShotState) { state.Pending[0].Aim = math.NaN() }},
		{"infinite", func(state *SingleShotState) { state.Pending[0].Aim = math.Inf(1) }},
		{"future", func(state *SingleShotState) { state.Pending[0].ObservedTick = 41 }},
		{"stale", func(state *SingleShotState) { state.Pending[0].ObservedTick = 0 }},
		{"generation", func(state *SingleShotState) { state.Pending[0].Generation++ }},
		{"zero_generation", func(state *SingleShotState) { state.Generation = 0; state.Pending[0].Generation = 0 }},
		{"duplicate", func(state *SingleShotState) { state.Pending = append(state.Pending, state.Pending[0]) }},
		{"changed", func(state *SingleShotState) { state.Changed = false }},
		{"accepted_overflow", func(state *SingleShotState) { state.Accepted = make([]uint32, MaxRememberedSingleShots+1) }},
		{"accepted_duplicate", func(state *SingleShotState) { state.Accepted = []uint32{1, 1} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := NewSim(42, []uint32{1}, nil)
			for range 40 {
				s.Tick()
			}
			s.ApplyInput(1, shotInput(s, 1, 0))
			cp := s.Snapshot()
			tc.edit(&cp.Robots[0].SingleShots)
			if _, err := RestoreCheckpoint(cp, nil); err == nil {
				t.Fatal("invalid checkpoint accepted")
			}
			if err := validateRecord(diskRecord{Type: "control", Tick: 41, RobotID: 1, Control: &ControlRecord{SingleShots: &cp.Robots[0].SingleShots}}); err == nil {
				t.Fatal("invalid control accepted")
			}
		})
	}
	s := NewSim(42, []uint32{1}, nil)
	s.ApplyInput(1, shotInput(s, 1, 0))
	cp := s.Snapshot()
	cp.Robots[0].SingleShots.Pending[0].Seq = 2
	if _, err := RestoreCheckpoint(cp, nil); err == nil {
		t.Fatal("shot beyond latest input seq accepted")
	}
}

func TestSingleShotHistoricalVersionGuard(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	s.simulationVersion = 7
	if outcome := s.ApplyInputOutcome(1, shotInput(s, 1, 0)); outcome != "unsupported" {
		t.Fatalf("old semantics: %q", outcome)
	}
	if s.SetInputGeneration(1, 20) {
		t.Fatal("old replay gained generation control")
	}
	record := LogRecord{Type: RecordControl, RobotID: 1, Control: &ControlRecord{SingleShots: &SingleShotState{Generation: 2, Changed: true}}}
	if err := s.applyReplayRecord(record); err == nil {
		t.Fatal("historical replay accepted discrete state")
	}
	cp := s.Snapshot()
	cp.Robots[0].SingleShots.Pending = []SingleShotIntent{{Seq: 1, Generation: 1}}
	cp.Robots[0].SingleShots.Changed = true
	if _, err := RestoreCheckpoint(cp, nil); err == nil {
		t.Fatal("historical checkpoint accepted discrete state")
	}
}

func TestSingleShotReplayEventsAndPendingBoundary(t *testing.T) {
	var buf bytes.Buffer
	log, _ := NewMatchEventLogWriter(&buf)
	s := NewSim(42, []uint32{1}, log)
	// Initial checkpoint already includes a pending intent; replay must not append
	// its subsequent control record to that lane or fire it twice.
	s.ApplyInput(1, shotInput(s, 1, 0))
	for tick := uint32(1); tick <= 50; tick++ {
		switch tick {
		case 2, 20:
			s.ApplyInput(1, shotInput(s, tick, float64(tick)))
		case 21:
			s.ApplyInput(1, &ombv1.ClientInput{Seq: tick, AxisMask: uint32(AxisFire), Fire: true})
		case 22:
			s.ApplyInput(1, shotInput(s, tick, 2))
		case 30:
			s.Respawn(1)
			s.ApplyInput(1, shotInput(s, tick, 3))
		case 40:
			s.RotateInputGeneration(1)
			s.ApplyInput(1, shotInput(s, tick, 4))
		}
		s.Tick()
	}
	s.Say(1, "coverage")
	s.Tick()
	log.Flush()
	records, err := ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	sink := &recordingSink{}
	replay, err := ReplayTo(bytes.NewReader(buf.Bytes()), s.tick, sink)
	if err != nil {
		t.Fatal(err)
	}
	var expected []*ombv1.ServerEvent
	for _, rec := range records {
		if rec.Event != nil {
			expected = append(expected, rec.Event)
		}
	}
	if len(expected) != len(sink.events) {
		t.Fatalf("event count: %d vs %d", len(expected), len(sink.events))
	}
	for i := range expected {
		if !proto.Equal(expected[i], sink.events[i]) {
			t.Fatalf("event %d differs", i)
		}
	}
	want, _ := json.Marshal(s.Snapshot())
	got, _ := json.Marshal(replay.Snapshot())
	if !bytes.Equal(want, got) {
		t.Fatal("mixed replay diverged")
	}
}

func TestSingleShotSequenceZeroAfterTickZeroCheckpoint(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	s.Tick()
	if !s.ApplyInput(1, shotInput(s, 0, 0)) {
		t.Fatal("initial sequence zero rejected")
	}
	if _, err := RestoreCheckpoint(s.Snapshot(), nil); err != nil {
		t.Fatalf("legal initial seq zero checkpoint: %v", err)
	}
}

func TestSingleShotDoesNotBypassHandBackArbitration(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(42, []uint32{1}, sink)
	s.SetAssist(1, true)
	s.Tick()
	s.ApplyInput(1, shotInput(s, 1, 0))
	s.AssistToggle(1)
	s.Tick()
	if len(s.projectiles) != 0 {
		t.Fatal("discrete shot bypassed explicit axis hand-back")
	}
	found := false
	for _, ev := range sink.events {
		if result := ev.GetSingleShotResult(); result != nil {
			found = result.Seq == 1 && result.Outcome == "ownership"
		}
	}
	if !found {
		t.Fatal("missing ownership terminal result")
	}
}

func TestSingleShotReplayContinuityRejectsControlPastSequenceEvenOnSeek(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	s.ApplyInput(1, shotInput(s, 1, 0))
	initial := s.Snapshot()
	control := cloneSingleShots(initial.Robots[0].SingleShots)
	input := initial.Robots[0].PendingInput
	records := []LogRecord{
		{Type: RecordMatchStart, State: &initial},
		{Type: RecordInput, Tick: 1, RobotID: 1, Input: &input},
		{Type: RecordControl, Tick: 1, RobotID: 1, Control: &ControlRecord{SingleShots: &control}},
	}
	control.Pending[0].Seq = 2
	if err := validateReplayContinuity(records); err == nil {
		t.Fatal("invalid pre-checkpoint control sequence accepted")
	}
	control.Pending[0].Seq = 1
	control.Accepted = []uint32{1, 2}
	if err := validateReplayContinuity(records); err == nil {
		t.Fatal("invalid pre-checkpoint dedup sequence accepted")
	}
}

func TestSingleShotFeedbackDedupIsBoundedAndCheckpointed(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	for seq := uint32(0); seq < MaxRememberedSingleShots+10; seq++ {
		if !s.ApplyInput(1, shotInput(s, seq, 0)) {
			t.Fatal("valid shot not admitted")
		}
		s.Tick()
	}
	r, _ := s.Robot(1)
	if len(r.SingleShots.Accepted) != MaxRememberedSingleShots {
		t.Fatal("unbounded feedback cache")
	}
	resumed, err := RestoreCheckpoint(s.Snapshot(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !resumed.SingleShotAccepted(1, MaxRememberedSingleShots+9, r.SingleShots.Generation) {
		t.Fatal("checkpoint lost accepted identity")
	}
	if resumed.SingleShotAccepted(1, MaxRememberedSingleShots+9, r.SingleShots.Generation+1) {
		t.Fatal("dedup crossed generation")
	}
}

func TestSingleShotFeedbackHorizonSurvivesCheckpoint(t *testing.T) {
	s := NewSim(42, []uint32{1}, nil)
	for seq := uint32(100); seq <= 164; seq += 2 {
		if !s.ApplyInput(1, shotInput(s, seq, 0)) {
			t.Fatal("shot not admitted")
		}
		s.Tick()
	}
	resumed, err := RestoreCheckpoint(s.Snapshot(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, world := range []*Sim{s, resumed} {
		r, _ := world.Robot(1)
		if len(r.SingleShots.Accepted) != MaxRememberedSingleShots {
			t.Fatal("feedback cache grew")
		}
		if !world.SingleShotFeedbackSuppressed(1, 100, r.SingleShots.Generation) {
			t.Fatal("evicted accepted ID received ambiguous rejection")
		}
		if world.SingleShotFeedbackSuppressed(1, 163, r.SingleShots.Generation) {
			t.Fatal("recent unknown ID suppressed")
		}
		if world.SingleShotFeedbackSuppressed(1, 165, r.SingleShots.Generation) {
			t.Fatal("fresh ID suppressed")
		}
		if world.SingleShotFeedbackSuppressed(1, 100, r.SingleShots.Generation+1) {
			t.Fatal("horizon leaked across generations")
		}
		if world.ApplyInput(1, shotInput(world, 100, 0)) {
			t.Fatal("evicted duplicate admitted")
		}
	}
}
