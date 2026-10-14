package sim

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func TestSetDurationsValidation(t *testing.T) {
	for _, tc := range []struct {
		name                string
		match, core         uint32
		wantErr             bool
		wantMatch, wantCore uint32
	}{
		{"defaults", 0, 0, false, MatchTicks, CoreOpenTick},
		{"explicit defaults", 8 * 60 * TickRate, 4 * 60 * TickRate, false, MatchTicks, CoreOpenTick},
		{"short match explicit core", 2 * 60 * TickRate, 60 * TickRate, false, 2 * 60 * TickRate, 60 * TickRate},
		{"short match default core invalid", 2 * 60 * TickRate, 0, true, 0, 0},
		{"too short", uint32(30 * TickRate), 60, true, 0, 0},
		{"too long", 31 * 60 * TickRate, 30 * 60 * TickRate, true, 0, 0},
		{"core at end", 8 * 60 * TickRate, 8 * 60 * TickRate, true, 0, 0},
		{"core beyond end", 8 * 60 * TickRate, 9 * 60 * TickRate, true, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := NewSim(1, []uint32{7}, nil)
			err := s.SetDurations(tc.match, tc.core)
			if tc.wantErr {
				if err == nil {
					t.Fatal("invalid durations accepted")
				}
				if s.MatchTickLimit() != MatchTicks || s.CoreOpenAt() != CoreOpenTick {
					t.Fatal("rejected call must not mutate state")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if s.MatchTickLimit() != tc.wantMatch || s.CoreOpenAt() != tc.wantCore {
				t.Fatalf("resolved durations = %d/%d, want %d/%d", s.MatchTickLimit(), s.CoreOpenAt(), tc.wantMatch, tc.wantCore)
			}
		})
	}
}

func TestSetDurationsOnlyBeforeFirstTick(t *testing.T) {
	s := NewSim(1, []uint32{7}, nil)
	s.Tick()
	if err := s.SetDurations(0, 0); err == nil {
		t.Fatal("durations configurable after first tick")
	}
}

// countingSink 统计 checkpoint 与 MatchEnd 标记（终局 checkpoint 断言用）。
type countingSink struct {
	checkpoints []Checkpoint
	ends        []uint32
}

func (c *countingSink) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	if ev.GetMatchEnd() != nil {
		c.ends = append(c.ends, tick)
	}
}
func (c *countingSink) OnCheckpoint(state Checkpoint) { c.checkpoints = append(c.checkpoints, state) }

func TestConfiguredDurationsDrivePhaseAndEnd(t *testing.T) {
	sink := &countingSink{}
	s := NewSim(1, []uint32{7}, sink)
	matchTicks := uint32(2 * 60 * TickRate)
	coreOpen := uint32(60 * TickRate)
	if err := s.SetDurations(matchTicks, coreOpen); err != nil {
		t.Fatal(err)
	}
	seenCoreOpen := false
	for i := uint32(0); i < matchTicks; i++ {
		s.Tick()
		if i+1 == coreOpen {
			seenCoreOpen = s.Phase() == ombv1.Phase_CORE_OPEN
		}
	}
	if !seenCoreOpen {
		t.Fatal("phase did not change at configured core open tick")
	}
	if !s.Ended() || len(sink.ends) != 1 || sink.ends[0] != matchTicks {
		t.Fatalf("match did not end at configured tick: ended=%v ends=%v", s.Ended(), sink.ends)
	}
	last := sink.checkpoints[len(sink.checkpoints)-1]
	if last.Tick != matchTicks || !last.Ended || last.MatchTicks != matchTicks || last.CoreOpenTick != coreOpen {
		t.Fatalf("final checkpoint must carry end state and durations: %+v", last)
	}
}

func TestFinishEarlyEndsWithFinalCheckpoint(t *testing.T) {
	sink := &countingSink{}
	s := NewSim(1, []uint32{7}, sink)
	for i := 0; i < 300; i++ {
		s.Tick()
	}
	if !s.FinishEarly() {
		t.Fatal("finish request rejected on running match")
	}
	if s.Ended() {
		t.Fatal("finish must not end the match before its final tick")
	}
	s.Tick()
	if !s.Ended() || len(sink.ends) != 1 || sink.ends[0] != 301 {
		t.Fatalf("early finish must end exactly once at next tick: ended=%v ends=%v", s.Ended(), sink.ends)
	}
	if len(sink.checkpoints) == 0 {
		t.Fatal("early finish must force a final checkpoint")
	}
	last := sink.checkpoints[len(sink.checkpoints)-1]
	if last.Tick != 301 || !last.Ended {
		t.Fatalf("final checkpoint must reflect the early end: %+v", last)
	}
	// 已结束后：FinishEarly 幂等拒绝，Tick 空转。
	if s.FinishEarly() {
		t.Fatal("finish request accepted on ended match")
	}
	s.Tick()
	if s.CurrentTick() != 301 || len(sink.ends) != 1 {
		t.Fatal("ticks after end must be no-ops")
	}
}

func TestRestoreCheckpointRoundTripsDurations(t *testing.T) {
	s := NewSim(1, []uint32{7}, nil)
	matchTicks := uint32(5 * 60 * TickRate)
	coreOpen := uint32(60 * TickRate)
	if err := s.SetDurations(matchTicks, coreOpen); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 120; i++ {
		s.Tick()
	}
	restored, err := RestoreCheckpoint(s.Snapshot(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if restored.MatchTickLimit() != matchTicks || restored.CoreOpenAt() != coreOpen {
		t.Fatalf("restored durations = %d/%d", restored.MatchTickLimit(), restored.CoreOpenAt())
	}
	// 提前结算形态的 checkpoint（Ended 且未到点）必须可恢复。
	early := s.Snapshot()
	early.Ended = true
	if _, err := RestoreCheckpoint(early, nil); err != nil {
		t.Fatalf("early-finished checkpoint rejected: %v", err)
	}
	// 未结束但已到点：非法。
	atEnd := s.Snapshot()
	atEnd.Tick = matchTicks
	if _, err := RestoreCheckpoint(atEnd, nil); err == nil {
		t.Fatal("not-ended checkpoint at match end accepted")
	}
}
