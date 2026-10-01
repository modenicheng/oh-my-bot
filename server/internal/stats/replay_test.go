package stats

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	sim "github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// goldenFeed builds the golden match: 4 robots, every event type at least
// once, checkpoints with real movement, a full 13-title outcome. Returns the
// ordered feed for both the live projector and the JSONL writer.
//
// Cast design (all distances within the 8 m/s checkpoint cap):
//
//	r1: 2 kills (WAR_MACHINE), kills assisted by partner r2 (BEST_PARTNER 1-2),
//	    3 hits, no AI (OLD_SCHOOL), moves 6+4=10m
//	r2: partner of r1; 1 core pickup only; 3 AI rounds (AI_REGULAR)
//	r3: 2 cores + 1 mega (SCAVENGER), 2 uplinks (SIGNAL_THIEF), 2 script
//	    errors (AI_IDIOT), 7 hits (BARRAGE), 3 wall hits (WALL_HEAD),
//	    dies twice (CNMB), longest alive run (SURVIVOR), big distance (RUNNER)
//	r4: 1 uplink, 1 wall hit, 1 death, 1 script error, tiny distance
type goldenEvent struct {
	tick uint32
	ev   *ombv1.ServerEvent
}

func goldenFeed() (events []goldenEvent, checkpoints []sim.Checkpoint) {
	events = append(events,
		goldenEvent{1, matchStart(1)},
		// every no-op type present for full-consumption replay equality
		goldenEvent{1, phaseChange(1)},
		goldenEvent{2, say(2, 1, "glhf")},
		goldenEvent{3, &ombv1.ServerEvent{Tick: 3, Kind: &ombv1.ServerEvent_RoomState{
			RoomState: &ombv1.EvRoomState{State: ombv1.EvRoomState_R_RUNNING, RobotsOnline: 4, HostNick: "h"}}}},
		goldenEvent{4, &ombv1.ServerEvent{Tick: 4, Kind: &ombv1.ServerEvent_MapBootstrap{
			MapBootstrap: &ombv1.EvMapBootstrap{MapJson: "{}", MapHash: "hash", GeneratorVersion: 1}}}},
		goldenEvent{5, &ombv1.ServerEvent{Tick: 5, Kind: &ombv1.ServerEvent_AiQuota{
			AiQuota: &ombv1.EvAiQuota{RoundsLeft: 19, TokensUsedK: 1, GlobalTokensLeftK: 2000}}}},
		goldenEvent{6, &ombv1.ServerEvent{Tick: 6, Kind: &ombv1.ServerEvent_ScriptResult{
			ScriptResult: &ombv1.EvScriptResult{ClientScriptId: 9, Ok: true, ScriptRev: 2}}}},

		// r3 scavenges
		goldenEvent{100, core(100, 3, 10)},
		goldenEvent{110, core(110, 3, 10)},
		goldenEvent{120, core(120, 3, 25)}, // mega
		goldenEvent{130, core(130, 2, 10)}, // r2 one core

		// r3 hacks
		goldenEvent{140, uplink(140, 3, 15)},
		goldenEvent{150, uplink(150, 3, 15)},
		goldenEvent{160, uplink(160, 4, 15)},

		// combat: r1 kills r3 twice (assisted by partner r2); r4 kills r3 once
		goldenEvent{200, hit(200, 1, 3, 5)},
		goldenEvent{201, hit(201, 1, 3, 5)},
		goldenEvent{202, hit(202, 1, 3, 5)},
		goldenEvent{210, kill(210, 1, 3, 2)}, // r1 kill #1, mutual assist r2
		goldenEvent{220, respawn(220, 3)},
		goldenEvent{230, kill(230, 1, 3, 2)}, // r1 kill #2, mutual assist r2
		goldenEvent{240, respawn(240, 3)},
		goldenEvent{250, kill(250, 4, 3, 0)}, // r4 kills r3 (r3 death #3)
		goldenEvent{260, respawn(260, 3)},
		goldenEvent{270, kill(270, 3, 4, 0)}, // r3 gets revenge (not title-relevant)
		goldenEvent{280, kill(280, 4, 1, 0)}, // r1 dies once: SURVIVOR stays with r3
		goldenEvent{290, respawn(290, 1)},

		// r3 barrage
		goldenEvent{300, hit(300, 3, 4, 4)},
		goldenEvent{301, hit(301, 3, 4, 4)},
		goldenEvent{302, hit(302, 3, 4, 4)},
		goldenEvent{303, hit(303, 3, 4, 4)},
		goldenEvent{304, hit(304, 3, 4, 4)},
		goldenEvent{305, hit(305, 3, 4, 4)},
		goldenEvent{306, hit(306, 3, 4, 4)},

		// r3 wall head
		goldenEvent{320, wallHit(320, 3)},
		goldenEvent{321, wallHit(321, 3)},
		goldenEvent{322, wallHit(322, 3)},
		goldenEvent{323, wallHit(323, 4)},

		// AI usage
		goldenEvent{340, aiUsage(340, 2, 3)},
		goldenEvent{341, aiUsage(341, 4, 1)},

		// script errors
		goldenEvent{360, scriptErr(360, 3)},
		goldenEvent{361, scriptErr(361, 3)},
		goldenEvent{362, scriptErr(362, 4)},

		// r2 dies once too (r4's second kill → WAR_MACHINE tie, first achiever r1)
		goldenEvent{1000, kill(1000, 4, 2, 0)},
		goldenEvent{1010, respawn(1010, 2)},
	)

	// checkpoints: r1 moves 6 then 4 (10m); r3 moves 7 then 7 (14m, RUNNER);
	// r2/r4 near-static (r4 1m).
	// Checkpoint ticks must be multiples of sim.CheckpointInterval (60s);
	// distances stay far under the 8m/s × 60s cap.
	checkpoints = append(checkpoints,
		sim.Checkpoint{Tick: 3600, Robots: []sim.Robot{
			robPos(1, 0, 0), robPos(2, 50, 50), robPos(3, 0, 0), robPos(4, -50, -50)},
			Walls: goldenWalls()},
		sim.Checkpoint{Tick: 7200, Robots: []sim.Robot{
			robPos(1, 6, 0), robPos(2, 50.5, 50), robPos(3, 7, 0), robPos(4, -49.5, -50)},
			Walls: goldenWalls()},
		sim.Checkpoint{Tick: 10800, Robots: []sim.Robot{
			robPos(1, 6, 4), robPos(2, 50.5, 50), robPos(3, 7, 7), robPos(4, -49.5, -50)},
			Walls: goldenWalls()},
	)

	events = append(events, goldenEvent{sim.MatchTicks, matchEnd(sim.MatchTicks)})
	return events, checkpoints
}

// goldenInitial is the tick-0 state both the live path (OnMatchInit) and the
// JSONL match_start line carry.
func goldenInitial() sim.Checkpoint {
	return sim.Checkpoint{Tick: 0, Seed: 42, Robots: []sim.Robot{
		robPos(1, 0, 0), robPos(2, 50, 50), robPos(3, 0, 0), robPos(4, -50, -50)},
		Walls: goldenWalls()}
}

// writeGoldenLog writes the golden match as a real JSONL log using the
// production sim.MatchEventLog (header, match_start, event, input lines,
// checkpoints, match_end) — the exact on-disk format the projector must read.
func writeGoldenLog(t *testing.T, events []goldenEvent, checkpoints []sim.Checkpoint) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "golden.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create golden log: %v", err)
	}
	defer f.Close()
	log, err := sim.NewMatchEventLogWriter(f)
	if err != nil {
		t.Fatalf("new log writer: %v", err)
	}

	log.OnMatchInit(goldenInitial())

	// Interleave: events/checkpoints in tick order, plus one input line to
	// prove input records are skipped harmlessly.
	cpIdx := 0
	for _, ge := range events {
		for cpIdx < len(checkpoints) && checkpoints[cpIdx].Tick < ge.tick {
			log.OnCheckpoint(checkpoints[cpIdx])
			cpIdx++
		}
		if ge.tick == 7 { // input and control records are both replay data
			log.OnInput(7, 1, sim.Input{Seq: 1, MoveX: 500, MoveY: 0})
			log.OnControl(7, 1, sim.ControlRecord{Toggles: 1})
		}
		log.OnEvent(ge.tick, ge.ev)
	}
	for ; cpIdx < len(checkpoints); cpIdx++ {
		log.OnCheckpoint(checkpoints[cpIdx])
	}
	if err := log.Close(); err != nil {
		t.Fatalf("close golden log: %v", err)
	}
	return path
}

// goldenOpts are the glue side tables injected into BOTH projectors.
func goldenOpts() ReadReplayOptions {
	return ReadReplayOptions{
		Players:  map[uint32]uint64{1: 101, 2: 102, 3: 103, 4: 104},
		Nicks:    map[uint32]string{1: "alice", 2: "bob", 3: "carol", 4: "dave"},
		Partners: map[uint32]uint32{1: 2, 2: 1, 3: 4, 4: 3},
	}
}

// goldenWalls satisfies the log's non-nil Walls requirement.
func goldenWalls() []sim.Wall {
	return []sim.Wall{{ID: 1, Min: sim.Vec2{X: -200, Y: -200}, Max: sim.Vec2{X: 200, Y: 200}}}
}

// TestGoldenReplayEqualsLiveProjection is the acceptance gate: replaying the
// JSONL through ReadReplay must produce EXACTLY the same Final() rows as the
// live projector fed event-by-event (scores, titles, identity, order).
func TestGoldenReplayEqualsLiveProjection(t *testing.T) {
	events, checkpoints := goldenFeed()

	// live path
	live := NewProjector()
	opts := goldenOpts()
	live.SetPlayerMap(opts.Players)
	live.SetNickMap(opts.Nicks)
	live.SetPartnerMap(opts.Partners)
	live.OnMatchInit(goldenInitial())
	cpIdx := 0
	for _, ge := range events {
		for cpIdx < len(checkpoints) && checkpoints[cpIdx].Tick < ge.tick {
			live.OnCheckpoint(checkpoints[cpIdx])
			cpIdx++
		}
		live.OnEvent(ge.tick, ge.ev)
	}
	for ; cpIdx < len(checkpoints); cpIdx++ {
		live.OnCheckpoint(checkpoints[cpIdx])
	}
	liveFinal := live.Final()

	// replay path
	path := writeGoldenLog(t, events, checkpoints)
	replayed, err := ReadReplay(path, opts)
	if err != nil {
		t.Fatalf("ReadReplay: %v", err)
	}
	replayFinal := replayed.Final()

	if len(liveFinal) != len(replayFinal) || len(liveFinal) != 4 {
		t.Fatalf("row counts: live=%d replay=%d (want 4)", len(liveFinal), len(replayFinal))
	}
	for i := range liveFinal {
		l, r := liveFinal[i], replayFinal[i]
		if l.RobotID != r.RobotID || l.PlayerID != r.PlayerID || l.Nick != r.Nick ||
			l.Score != r.Score || !sameTitles(l.Titles, r.Titles) {
			t.Errorf("row %d mismatch:\n live  = %+v (%v)\n replay= %+v (%v)",
				i, l, l.Titles, r, r.Titles)
		}
	}

	// Live snapshots must agree too (tick = MatchTicks).
	ls, rs := live.Live(), replayed.Live()
	if ls.Tick != rs.Tick {
		t.Errorf("live tick %d != replay tick %d", ls.Tick, rs.Tick)
	}
}

func sameTitles(a, b []TitleID) bool {
	if len(a) != len(b) {
		return false
	}
	set := make(map[TitleID]int, len(a))
	for _, x := range a {
		set[x]++
	}
	for _, x := range b {
		set[x]--
	}
	for _, v := range set {
		if v != 0 {
			return false
		}
	}
	return true
}

// TestGoldenTitles pin the exact 13-title outcome of the golden match so both
// paths are asserted against design intent, not just mutual equality.
func TestEmbeddedIdentityOverridesLegacyOptions(t *testing.T) {
	var buf bytes.Buffer
	log, err := sim.NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	identity := []sim.MatchPlayer{
		{RobotID: 1, PlayerID: 1001, Nick: "live host", Partner: 2},
		{RobotID: 2, PlayerID: 1002, Nick: "live bot", Partner: 1, Bot: true},
	}
	if err := log.SetPlayers(identity); err != nil {
		t.Fatal(err)
	}
	log.OnMatchInit(sim.Checkpoint{Robots: []sim.Robot{{ID: 1}, {ID: 2}}, Walls: []sim.Wall{}})
	log.OnEvent(1, matchStart(1))
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "with-identity.jsonl")
	if err := os.WriteFile(path, buf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := ReadReplay(path, ReadReplayOptions{Players: map[uint32]uint64{1: 9}, Nicks: map[uint32]string{1: "stale"}})
	if err != nil {
		t.Fatal(err)
	}
	rows := rowsByRobot(p.Final())
	if rows[1].PlayerID != 1001 || rows[1].Nick != "live host" || rows[2].PlayerID != 1002 || rows[2].Nick != "live bot" {
		t.Fatalf("replay ignored embedded identity: %+v", rows)
	}
}

func TestGoldenTitles(t *testing.T) {
	events, checkpoints := goldenFeed()
	path := writeGoldenLog(t, events, checkpoints)
	replayed, err := ReadReplay(path, goldenOpts())
	if err != nil {
		t.Fatalf("ReadReplay: %v", err)
	}
	rows := rowsByRobot(replayed.Final())

	// Survivor arithmetic (match ends at 28800):
	//   r3: last segment 260→28800 = 28540 (max) — beats r1 (28510),
	//   r2 (27790), r4 (re-bootstrapped at cp 3600 → 25200).
	// PEACEMAKER: threshold p75(30,53,65,107)=65; zero-kill players are
	// r2(30) — below threshold, so no PEACEMAKER in the golden match
	// (covered by TestTitlePeacemaker*).
	want := map[uint32][]TitleID{
		1: {ombv1.Title_BEST_PARTNER, ombv1.Title_OLD_SCHOOL},
		2: {ombv1.Title_AI_REGULAR, ombv1.Title_BEST_PARTNER},
		3: {ombv1.Title_SCAVENGER, ombv1.Title_SIGNAL_THIEF, ombv1.Title_BARRAGE,
			ombv1.Title_WALL_HEAD, ombv1.Title_CNMB, ombv1.Title_RUNNER,
			ombv1.Title_SURVIVOR, ombv1.Title_OLD_SCHOOL},
		4: {ombv1.Title_WAR_MACHINE},
	}
	for id, titles := range want {
		got := titlesOf(t, rows[id])
		for _, w := range titles {
			if !got[w] {
				t.Errorf("robot %d missing title %v (has %v)", id, w, rows[id].Titles)
			}
		}
	}
	// WAR_MACHINE: r4 3 kills > r1 2 kills → r4.
	if !titlesOf(t, rows[4])[ombv1.Title_WAR_MACHINE] {
		t.Errorf("robot 4 (3 kills) missing WAR_MACHINE; has %v", rows[4].Titles)
	}
	if titlesOf(t, rows[1])[ombv1.Title_WAR_MACHINE] {
		t.Errorf("robot 1 (2 kills) wrongly awarded WAR_MACHINE over r4's 3")
	}
	// PEACEMAKER absent from the golden match: ascending scores (30, 53, 90, 107)
	// → threshold p75 = 90; the only zero-kill player r2 (30) is below it.
	// Coverage lives in TestTitlePeacemaker / TestTitlePeacemakerBelowThreshold.
	for id := uint32(1); id <= 4; id++ {
		if titlesOf(t, rows[id])[ombv1.Title_PEACEMAKER] {
			t.Errorf("robot %d unexpectedly awarded PEACEMAKER in golden match", id)
		}
	}
}

// TestGoldenScores pins the exact score arithmetic through the replay path.
func TestGoldenScores(t *testing.T) {
	events, checkpoints := goldenFeed()
	path := writeGoldenLog(t, events, checkpoints)
	replayed, err := ReadReplay(path, goldenOpts())
	if err != nil {
		t.Fatalf("ReadReplay: %v", err)
	}
	rows := rowsByRobot(replayed.Final())
	// r1: 2 kills(50) + 3 hits(3) = 53 (assists credit r2)
	if rows[1].Score != 53 {
		t.Errorf("r1 score = %d, want 53", rows[1].Score)
	}
	// r2: 1 core(10) + 2 assists(20) = 30
	if rows[2].Score != 30 {
		t.Errorf("r2 score = %d, want 30", rows[2].Score)
	}
	// r3: cores 45 + uplinks 30 + 7 hits(7) + kill 25 = 107
	if rows[3].Score != 107 {
		t.Errorf("r3 score = %d, want 107", rows[3].Score)
	}
	// r4: 3 kills(75) + uplink(15) = 90
	if rows[4].Score != 90 {
		t.Errorf("r4 score = %d, want 90", rows[4].Score)
	}
}

// TestReadReplayErrors covers the failure modes: missing file, malformed line.
func TestReadReplayErrors(t *testing.T) {
	if _, err := ReadReplay(filepath.Join(t.TempDir(), "nope.jsonl"), ReadReplayOptions{}); err == nil {
		t.Error("missing file: expected error")
	}

	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.jsonl")
	// header ok, then garbage
	if err := os.WriteFile(bad, []byte("{\"schema_version\":1}\nnot json\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadReplay(bad, ReadReplayOptions{}); err == nil {
		t.Error("malformed body: expected error")
	}

	wrongSchema := filepath.Join(dir, "schema.jsonl")
	if err := os.WriteFile(wrongSchema, []byte("{\"schema_version\":99}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadReplay(wrongSchema, ReadReplayOptions{}); err == nil {
		t.Error("wrong schema: expected error")
	}
}

// TestReplayDuplicateFeedIdempotent writes a log, replays it, then replays the
// same records into the SAME projector a second time — totals must not move.
func TestReplayDuplicateFeedIdempotent(t *testing.T) {
	events, checkpoints := goldenFeed()
	path := writeGoldenLog(t, events, checkpoints)
	replayed, err := ReadReplay(path, goldenOpts())
	if err != nil {
		t.Fatalf("ReadReplay: %v", err)
	}
	f1 := replayed.Final()

	// Second pass over the same log into a fresh projector then feed BOTH
	// result sets through one projector — trivially identical since Final is
	// frozen; the real duplicate concern is OnEvent re-feed:
	p2 := NewProjector()
	opts := goldenOpts()
	p2.SetPlayerMap(opts.Players)
	p2.SetNickMap(opts.Nicks)
	p2.SetPartnerMap(opts.Partners)
	p2.OnMatchInit(goldenInitial())
	cpIdx := 0
	for _, ge := range events {
		for cpIdx < len(checkpoints) && checkpoints[cpIdx].Tick < ge.tick {
			p2.OnCheckpoint(checkpoints[cpIdx])
			p2.OnCheckpoint(checkpoints[cpIdx]) // duplicate checkpoint
			cpIdx++
		}
		p2.OnEvent(ge.tick, ge.ev)
		p2.OnEvent(ge.tick, ge.ev) // exact duplicate event
	}
	for ; cpIdx < len(checkpoints); cpIdx++ {
		p2.OnCheckpoint(checkpoints[cpIdx])
	}
	f2 := p2.Final()
	for i := range f1 {
		if f1[i].Score != f2[i].Score || !sameTitles(f1[i].Titles, f2[i].Titles) {
			t.Errorf("robot %d: single-feed %d/%v vs double-feed %d/%v",
				f1[i].RobotID, f1[i].Score, f1[i].Titles, f2[i].Score, f2[i].Titles)
		}
	}
}
