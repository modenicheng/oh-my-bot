package stats

import (
	"math"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	sim "github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- helpers ----
// The oneof wrapper types (ServerEvent_Kill etc.) are exported; the shared
// interface is not, so each helper builds the ServerEvent directly.

func kill(tick, killer, victim, assist uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_Kill{Kill: &ombv1.EvKill{
		Killer: killer, Victim: victim, Assist: assist}}}
}

func hit(tick, from, to uint32, dmg int32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_Hit{Hit: &ombv1.EvHit{From: from, To: to, Dmg: dmg}}}
}

func core(tick, by uint32, value int32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_CorePickup{CorePickup: &ombv1.EvCorePickup{By: by, Value: value}}}
}

func uplink(tick, by uint32, value int32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_UplinkHack{UplinkHack: &ombv1.EvUplinkHack{By: by, Value: value}}}
}

func wallHit(tick, robot uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_WallHit{WallHit: &ombv1.EvWallHit{Robot: robot, At: &ombv1.Vec2{X: 1, Y: 1}}}}
}

func scriptErr(tick, robot uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_ScriptError{ScriptError: &ombv1.EvScriptError{Robot: robot, Error: "boom"}}}
}

func aiUsage(tick, robot, rounds uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_AiUsage{AiUsage: &ombv1.EvAiUsage{Robot: robot, RoundsDelta: rounds}}}
}

func respawn(tick, robot uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_Respawn{Respawn: &ombv1.EvRespawn{Robot: robot, Sector: 2}}}
}

func say(tick, robot uint32, text string) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: robot, Text: text}}}
}

func matchEnd(tick uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_MatchEnd{MatchEnd: &ombv1.EvMatchEnd{}}}
}

func matchStart(tick uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_MatchStart{MatchStart: &ombv1.EvMatchStart{MapSeed: 7, Players: 3}}}
}

func phaseChange(tick uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_PhaseChange{PhaseChange: &ombv1.EvPhaseChange{
		From: ombv1.Phase_OUTER_RING, To: ombv1.Phase_CORE_OPEN}}}
}

// noOpEvents returns one instance of every event type with no stats effect.
func noOpEvents(tick uint32) []*ombv1.ServerEvent {
	return []*ombv1.ServerEvent{
		phaseChange(tick),
		say(tick, 1, "glhf"),
		&ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_RoomState{RoomState: &ombv1.EvRoomState{State: ombv1.EvRoomState_R_RUNNING, RobotsOnline: 3}}},
		&ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_AiQuota{AiQuota: &ombv1.EvAiQuota{RoundsLeft: 19}}},
		&ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_ScriptResult{ScriptResult: &ombv1.EvScriptResult{ClientScriptId: 1, Ok: true, ScriptRev: 1}}},
		&ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapHash: "h", GeneratorVersion: 1}}},
	}
}

func robPos(id uint32, x, y float64) sim.Robot {
	return sim.Robot{ID: id, Position: sim.Vec2{X: x, Y: y}, State: sim.Alive}
}

func rowsByRobot(rows []ScoreRow) map[uint32]ScoreRow {
	out := make(map[uint32]ScoreRow, len(rows))
	for _, r := range rows {
		out[r.RobotID] = r
	}
	return out
}

func titlesOf(t *testing.T, row ScoreRow) map[TitleID]bool {
	t.Helper()
	out := make(map[TitleID]bool, len(row.Titles))
	for _, id := range row.Titles {
		out[id] = true
	}
	return out
}

// ---- score accumulation ----

func TestScoreAccumulation(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, kill(10, 1, 2, 0)) // r1 kill +25
	p.OnEvent(11, kill(11, 2, 3, 1)) // r2 kill +25, r1 assist +10
	p.OnEvent(12, hit(12, 1, 2, 5))  // r1 hit +1
	p.OnEvent(13, hit(13, 1, 2, 5))  // r1 hit +1
	p.OnEvent(14, core(14, 3, 10))   // r3 core +10
	p.OnEvent(15, core(15, 3, 25))   // r3 mega +25
	p.OnEvent(16, uplink(16, 2, 15)) // r2 uplink +15
	p.OnEvent(17, uplink(17, 2, 25)) // r2 main uplink +25

	got := rowsByRobot(p.Live().Rows)
	want := map[uint32]int32{1: 25 + 10 + 1 + 1, 2: 25 + 15 + 25, 3: 10 + 25}
	for id, w := range want {
		if got[id].Score != w {
			t.Errorf("robot %d score = %d, want %d", id, got[id].Score, w)
		}
	}
	if p.Live().Tick != 17 {
		t.Errorf("live tick = %d, want 17", p.Live().Tick)
	}
}

func TestLiveSortedByScoreDesc(t *testing.T) {
	p := NewProjector()
	p.OnEvent(1, core(1, 1, 10))
	p.OnEvent(2, kill(2, 2, 1, 0))
	p.OnEvent(3, hit(3, 3, 1, 2))
	// scores: r2=25, r3=1, r1=10 → order 2,1,3
	rows := p.Live().Rows
	if rows[0].RobotID != 2 || rows[1].RobotID != 1 || rows[2].RobotID != 3 {
		t.Errorf("live order = %v,%v,%v; want 2,1,3", rows[0].RobotID, rows[1].RobotID, rows[2].RobotID)
	}
}

func TestLiveCarriesIdentity(t *testing.T) {
	p := NewProjector()
	p.SetPlayerMap(map[uint32]uint64{1: 100, 2: 200})
	p.SetNickMap(map[uint32]string{1: "alice", 2: "bob"})
	p.OnEvent(1, core(1, 1, 10))
	got := rowsByRobot(p.Live().Rows)
	if got[1].PlayerID != 100 || got[1].Nick != "alice" {
		t.Errorf("robot 1 identity = %+v", got[1])
	}
}

// ---- idempotency ----

func TestOnEventIdempotentOnReplay(t *testing.T) {
	p := NewProjector()
	feed := []*ombv1.ServerEvent{
		kill(10, 1, 2, 0),
		hit(11, 1, 2, 3),
		hit(11, 1, 2, 3), // same tick same payload: counted once (log has no seq)
		core(12, 1, 10),
		uplink(13, 1, 15),
		wallHit(14, 1),
		scriptErr(15, 1),
		aiUsage(16, 1, 2),
	}
	for _, e := range feed {
		p.OnEvent(e.Tick, e)
	}
	// Full replay of everything (out of order across ticks is still deduped).
	for _, e := range feed {
		p.OnEvent(e.Tick, e)
	}
	for _, e := range noOpEvents(17) {
		p.OnEvent(17, e)
		p.OnEvent(17, e)
	}
	got := rowsByRobot(p.Live().Rows)
	r1 := got[1]
	if r1.Score != 25+1+10+15 {
		t.Errorf("r1 score after replay = %d, want %d", r1.Score, 25+1+10+15)
	}
	if len(p.seen) == 0 {
		t.Fatal("dedup set empty")
	}
}

func TestEventsAfterMatchEndIgnored(t *testing.T) {
	p := NewProjector()
	p.OnEvent(100, core(100, 1, 10))
	p.OnEvent(101, matchEnd(101))
	p.OnEvent(102, core(102, 1, 10)) // after end: ignored
	got := rowsByRobot(p.Live().Rows)
	if got[1].Score != 10 {
		t.Errorf("score after match end = %d, want 10", got[1].Score)
	}
}

func TestOnCheckpointIdempotent(t *testing.T) {
	p := NewProjector()
	cp1 := sim.Checkpoint{Tick: 60, Robots: []sim.Robot{robPos(1, 0, 0)}}
	cp2 := sim.Checkpoint{Tick: 120, Robots: []sim.Robot{robPos(1, 7.5, 0)}} // 7.5m/s ≤ 8m/s cap
	p.OnCheckpoint(cp1)
	p.OnCheckpoint(cp2)
	p.OnCheckpoint(cp2) // duplicate: ignored
	p.OnCheckpoint(cp1) // backwards: ignored
	r := p.robots[1]
	if r.dist != 7.5 {
		t.Errorf("dist = %v, want 30", r.dist)
	}
}

// ---- RUNNER movement ----

func TestMovementDistanceCheckpointDiff(t *testing.T) {
	p := NewProjector()
	p.OnCheckpoint(sim.Checkpoint{Tick: 60, Robots: []sim.Robot{robPos(1, 0, 0)}})
	p.OnCheckpoint(sim.Checkpoint{Tick: 120, Robots: []sim.Robot{robPos(1, 6, 0)}}) // 6m in 1s
	p.OnCheckpoint(sim.Checkpoint{Tick: 180, Robots: []sim.Robot{robPos(1, 6, 4)}}) // 4m in 1s
	if d := p.robots[1].dist; math.Abs(d-10) > 1e-9 {
		t.Errorf("dist = %v, want 10", d)
	}
}

func TestMovementDistanceVsTruthUnder10Percent(t *testing.T) {
	// Physical truth walk at ~max speed (8 m/s) with a direction change
	// every 0.5s; checkpoint samples every 1s (60 ticks). Chord-vs-path
	// error must stay under the 10% budget from the frozen contract.
	// Legs of 4m alternating +x/+y: truth per 1s = 8m, chord = 4√2 ≈ 5.657.
	p := NewProjector()
	p.OnCheckpoint(sim.Checkpoint{Tick: 0, Robots: []sim.Robot{robPos(1, 0, 0)}})
	p.OnCheckpoint(sim.Checkpoint{Tick: 60, Robots: []sim.Robot{robPos(1, 8, 0)}})    // truth 8, chord 8
	p.OnCheckpoint(sim.Checkpoint{Tick: 120, Robots: []sim.Robot{robPos(1, 12, 4)}})  // truth 8, chord 4√2
	p.OnCheckpoint(sim.Checkpoint{Tick: 180, Robots: []sim.Robot{robPos(1, 12, 12)}}) // truth 8, chord 8
	const truth = 24.0
	err := math.Abs(p.robots[1].dist-truth) / truth
	if err >= 0.10 {
		t.Errorf("checkpoint dist %v vs truth %v: %.2f%% error (budget 10%%)",
			p.robots[1].dist, truth, err*100)
	}
}

func TestMovementTeleportNotCounted(t *testing.T) {
	p := NewProjector()
	p.OnCheckpoint(sim.Checkpoint{Tick: 60, Robots: []sim.Robot{robPos(1, 0, 0)}})
	// 480m in 60 ticks exceeds MaxSpeed(8m/s)*1s*slack ≈ 8.4m → teleport.
	p.OnCheckpoint(sim.Checkpoint{Tick: 120, Robots: []sim.Robot{robPos(1, 480, 0)}})
	if d := p.robots[1].dist; d != 0 {
		t.Errorf("teleport delta counted: dist = %v, want 0", d)
	}
	// Position re-seeded: subsequent legit motion counts from the new spot.
	p.OnCheckpoint(sim.Checkpoint{Tick: 180, Robots: []sim.Robot{robPos(1, 482, 0)}})
	if d := p.robots[1].dist; math.Abs(d-2) > 1e-9 {
		t.Errorf("dist after reseed = %v, want 2", d)
	}
}

func TestRespawnDropsPositionSeed(t *testing.T) {
	p := NewProjector()
	p.OnCheckpoint(sim.Checkpoint{Tick: 60, Robots: []sim.Robot{robPos(1, 0, 0)}})
	p.OnEvent(90, respawn(90, 1))
	// Respawn teleports (sector spawn unknown to projector); the delta must
	// be discarded, then motion from the new position accumulates.
	p.OnCheckpoint(sim.Checkpoint{Tick: 120, Robots: []sim.Robot{robPos(1, 200, 200)}})
	if d := p.robots[1].dist; d != 0 {
		t.Errorf("respawn teleport counted: dist = %v, want 0", d)
	}
	p.OnCheckpoint(sim.Checkpoint{Tick: 180, Robots: []sim.Robot{robPos(1, 203, 204)}})
	if d := p.robots[1].dist; math.Abs(d-5) > 1e-9 {
		t.Errorf("dist after respawn reseed = %v, want 5", d)
	}
}

// ---- SURVIVOR segments ----

func TestSurvivorSegmentsFromEvents(t *testing.T) {
	p := NewProjector()
	p.OnEvent(60, respawn(60, 1))      // alive from t60
	p.OnEvent(100, kill(100, 2, 1, 0)) // dead at t100 → segment 40
	p.OnEvent(163, respawn(163, 1))    // alive again (3s respawn = 180 ticks later per design; exact not load-bearing)
	p.OnEvent(500, kill(500, 2, 1, 0)) // segment 337
	p.OnEvent(700, matchEnd(700))      // open segment (500→700 dead) closed at end
	r := p.robots[1]
	if r.maxSurvTicks != 337 {
		t.Errorf("maxSurvTicks = %d, want 337", r.maxSurvTicks)
	}
}

func TestSurvivorBootstrapFromCheckpoint(t *testing.T) {
	// No respawn event seen: checkpoints bootstrap the alive segment.
	p := NewProjector()
	p.OnCheckpoint(sim.Checkpoint{Tick: 60, Robots: []sim.Robot{robPos(1, 0, 0)}})
	p.OnCheckpoint(sim.Checkpoint{Tick: 120, Robots: []sim.Robot{robPos(1, 7, 0)}})
	p.OnEvent(300, kill(300, 2, 1, 0))
	if r := p.robots[1]; r.maxSurvTicks != 240 {
		t.Errorf("maxSurvTicks = %d, want 240", r.maxSurvTicks)
	}
}

// ---- Final caching ----

func TestFinalComputedOnce(t *testing.T) {
	p := NewProjector()
	p.OnEvent(1, core(1, 1, 10))
	p.OnEvent(2, matchEnd(2))
	f1 := p.Final()
	f1[0].Score = 999 // mutate returned slice: must not affect cache
	f2 := p.Final()
	if f2[0].Score != 10 {
		t.Errorf("Final not frozen: got %d, want 10", f2[0].Score)
	}
	if len(f2[0].Titles) == 0 {
		t.Error("expected at least one title (SCAVENGER) for sole core picker")
	}
}

func TestNilAndMalformedEventsIgnored(t *testing.T) {
	p := NewProjector()
	p.OnEvent(1, nil)
	p.OnEvent(2, &ombv1.ServerEvent{Tick: 2, Kind: nil})
	p.OnEvent(3, &ombv1.ServerEvent{Tick: 3, Kind: &ombv1.ServerEvent_Kill{Kill: nil}})
	if got := p.Live().Rows; len(got) != 0 {
		t.Errorf("nil-kind events created rows: %v", got)
	}
}
