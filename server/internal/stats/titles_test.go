package stats

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	sim "github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// One test per title (13/13), each asserting both the award and the negative
// (who does NOT get it), plus the first-achiever tie-break where relevant.

func feedFinal(p *ProjectorImpl) map[uint32]ScoreRow {
	return rowsByRobot(p.Final())
}

// 1. WAR_MACHINE — most kills.
func TestTitleWarMachine(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, kill(10, 1, 2, 0))
	p.OnEvent(20, kill(20, 1, 3, 0))
	p.OnEvent(30, kill(30, 2, 3, 0))
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_WAR_MACHINE] {
		t.Errorf("robot 1 (2 kills) missing WAR_MACHINE; titles=%v", rows[1].Titles)
	}
	if titlesOf(t, rows[2])[ombv1.Title_WAR_MACHINE] {
		t.Errorf("robot 2 (1 kill) wrongly awarded WAR_MACHINE")
	}
}

// 2. SCAVENGER — most core pickups.
func TestTitleScavenger(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, core(10, 2, 10))
	p.OnEvent(20, core(20, 2, 10))
	p.OnEvent(30, core(30, 1, 25)) // mega value does not matter: count does
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[2])[ombv1.Title_SCAVENGER] {
		t.Errorf("robot 2 missing SCAVENGER; titles=%v", rows[2].Titles)
	}
	if titlesOf(t, rows[1])[ombv1.Title_SCAVENGER] {
		t.Errorf("robot 1 wrongly awarded SCAVENGER")
	}
}

// 3. SIGNAL_THIEF — most uplink hacks.
func TestTitleSignalThief(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, uplink(10, 1, 15))
	p.OnEvent(20, uplink(20, 1, 25))
	p.OnEvent(30, uplink(30, 3, 15))
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_SIGNAL_THIEF] {
		t.Errorf("robot 1 missing SIGNAL_THIEF; titles=%v", rows[1].Titles)
	}
	if titlesOf(t, rows[3])[ombv1.Title_SIGNAL_THIEF] {
		t.Errorf("robot 3 wrongly awarded SIGNAL_THIEF")
	}
}

// 4. RUNNER — longest checkpoint distance.
func TestTitleRunner(t *testing.T) {
	p := NewProjector()
	p.OnCheckpoint(cp2(60, 1, 0, 0, 2, 0, 0))
	p.OnCheckpoint(cp2(120, 1, 7, 0, 2, 3, 0)) // r1 +7, r2 +3
	p.OnCheckpoint(cp2(180, 1, 7, 4, 2, 3, 4)) // r1 +4 (11), r2 +4 (7)
	p.OnEvent(200, matchEnd(200))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_RUNNER] {
		t.Errorf("robot 1 (dist 11) missing RUNNER; titles=%v", rows[1].Titles)
	}
	if titlesOf(t, rows[2])[ombv1.Title_RUNNER] {
		t.Errorf("robot 2 (dist 7) wrongly awarded RUNNER")
	}
}

// 5. WALL_HEAD — most wall hits.
func TestTitleWallHead(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, wallHit(10, 3))
	p.OnEvent(20, wallHit(20, 3))
	p.OnEvent(30, wallHit(30, 1))
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[3])[ombv1.Title_WALL_HEAD] {
		t.Errorf("robot 3 missing WALL_HEAD; titles=%v", rows[3].Titles)
	}
	if titlesOf(t, rows[1])[ombv1.Title_WALL_HEAD] {
		t.Errorf("robot 1 wrongly awarded WALL_HEAD")
	}
}

// 6. SURVIVOR — longest contiguous alive segment.
func TestTitleSurvivor(t *testing.T) {
	p := NewProjector()
	p.OnEvent(60, respawn(60, 1)) // r1 alive 60→end 500 = 440
	p.OnEvent(60, respawn(60, 2))
	p.OnEvent(100, kill(100, 1, 2, 0)) // r2 segment 40
	p.OnEvent(280, respawn(280, 2))    // r2 alive 280→500 = 220
	p.OnEvent(500, matchEnd(500))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_SURVIVOR] {
		t.Errorf("robot 1 (440 ticks) missing SURVIVOR; titles=%v", rows[1].Titles)
	}
	if titlesOf(t, rows[2])[ombv1.Title_SURVIVOR] {
		t.Errorf("robot 2 (max 220) wrongly awarded SURVIVOR")
	}
}

// 7. PEACEMAKER — score >= p75 AND zero kills.
func TestTitlePeacemaker(t *testing.T) {
	// 4 players, scores 100/50/25/25: ascending 25,25,50,100,
	// p75 nearest-rank = ceil(0.75*4)=3rd ascending = 50. Threshold 50.
	p := NewProjector()
	for i := 0; i < 10; i++ {
		p.OnEvent(uint32(i+1), core(uint32(i+1), 1, 10)) // r1 = 100, 0 kills
	}
	for i := 0; i < 5; i++ {
		p.OnEvent(uint32(20+i), core(uint32(20+i), 2, 10)) // r2 = 50
	}
	p.OnEvent(30, core(30, 3, 25))   // r3 = 25 (below threshold)
	p.OnEvent(40, kill(40, 4, 3, 0)) // r4 = 25 but has kills
	p.OnEvent(50, matchEnd(50))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_PEACEMAKER] {
		t.Errorf("robot 1 (100pts, 0 kills) missing PEACEMAKER; titles=%v", rows[1].Titles)
	}
	if !titlesOf(t, rows[2])[ombv1.Title_PEACEMAKER] {
		t.Errorf("robot 2 (50pts == threshold, 0 kills) missing PEACEMAKER; titles=%v", rows[2].Titles)
	}
	if titlesOf(t, rows[3])[ombv1.Title_PEACEMAKER] {
		t.Errorf("robot 3 (25pts < threshold 50) wrongly awarded PEACEMAKER")
	}
	if titlesOf(t, rows[4])[ombv1.Title_PEACEMAKER] {
		t.Errorf("robot 4 (1 kill) wrongly awarded PEACEMAKER despite kills")
	}
}

// 7b. PEACEMAKER negative: below threshold with zero kills.
func TestTitlePeacemakerBelowThreshold(t *testing.T) {
	// scores 90/60/1, ascending → p75 rank ceil(2.25)=3 → threshold 90.
	p := NewProjector()
	for i := 0; i < 9; i++ {
		p.OnEvent(uint32(i+1), core(uint32(i+1), 1, 10)) // r1 = 90
	}
	for i := 0; i < 6; i++ {
		p.OnEvent(uint32(20+i), core(uint32(20+i), 2, 10)) // r2 = 60
	}
	p.OnEvent(30, hit(30, 3, 1, 2)) // r3 = 1 point only
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if titlesOf(t, rows[3])[ombv1.Title_PEACEMAKER] {
		t.Errorf("robot 3 (1pt < threshold 90) wrongly awarded PEACEMAKER")
	}
	if !titlesOf(t, rows[1])[ombv1.Title_PEACEMAKER] {
		t.Errorf("robot 1 (90pts == threshold, 0 kills) missing PEACEMAKER")
	}
}

// 8. AI_IDIOT — most script errors.
func TestTitleAiIdiot(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, scriptErr(10, 2))
	p.OnEvent(20, scriptErr(20, 2))
	p.OnEvent(30, scriptErr(30, 1))
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[2])[ombv1.Title_AI_IDIOT] {
		t.Errorf("robot 2 missing AI_IDIOT; titles=%v", rows[2].Titles)
	}
	if titlesOf(t, rows[1])[ombv1.Title_AI_IDIOT] {
		t.Errorf("robot 1 wrongly awarded AI_IDIOT")
	}
}

// 9. BARRAGE — most shots (EvHit from count).
func TestTitleBarrage(t *testing.T) {
	p := NewProjector()
	for i := uint32(0); i < 5; i++ {
		p.OnEvent(10+i, hit(10+i, 1, 2, 3))
	}
	for i := uint32(0); i < 3; i++ {
		p.OnEvent(20+i, hit(20+i, 2, 1, 3))
	}
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_BARRAGE] {
		t.Errorf("robot 1 (5 hits) missing BARRAGE; titles=%v", rows[1].Titles)
	}
	if titlesOf(t, rows[2])[ombv1.Title_BARRAGE] {
		t.Errorf("robot 2 (3 hits) wrongly awarded BARRAGE")
	}
}

// Deprecated BEST_PARTNER input remains accepted but never awards a live title.
func TestDeprecatedBestPartnerNeverAwards(t *testing.T) {
	p := NewProjector()
	p.SetPartnerMap(map[uint32]uint32{1: 2, 2: 1})
	p.OnEvent(10, kill(10, 1, 3, 2))
	p.OnEvent(30, matchEnd(30))
	for id, row := range feedFinal(p) {
		//nolint:staticcheck // Title_BEST_PARTNER 已弃用：断言不再产出该称号
		if titlesOf(t, row)[ombv1.Title_BEST_PARTNER] {
			t.Errorf("robot %d awarded deprecated BEST_PARTNER", id)
		}
	}
}

func heal(tick, by, id uint32, amountX10 int32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_Heal{Heal: &ombv1.EvHeal{By: by, Id: id, HealX10: amountX10}}}
}

func TestTitleHealerFirstAchieverAndZeroSuppression(t *testing.T) {
	zero := NewProjector()
	zero.OnEvent(10, matchEnd(10))
	if rows := feedFinal(zero); len(rows) != 0 {
		for id, row := range rows {
			if titlesOf(t, row)[ombv1.Title_HEALER] {
				t.Fatalf("robot %d received zero-value HEALER", id)
			}
		}
	}

	p := NewProjector()
	p.OnEvent(10, heal(10, 2, 1, 300))
	p.OnEvent(20, heal(20, 1, 2, 200))
	p.OnEvent(30, heal(30, 1, 3, 100))
	p.OnEvent(30, heal(30, 1, 3, 100)) // replay duplicate must not count twice
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[2])[ombv1.Title_HEALER] {
		t.Fatalf("first achiever missing HEALER: %v", rows[2].Titles)
	}
	if titlesOf(t, rows[1])[ombv1.Title_HEALER] {
		t.Fatal("later tied robot received HEALER")
	}
	if rows[1].Score != 0 || rows[2].Score != 0 {
		t.Fatalf("healing invented score rewards: %+v", rows)
	}
}

func TestTitleKillStealFirstAchiever(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, attributedKill(10, 2, 4, nil, true))
	p.OnEvent(20, attributedKill(20, 1, 3, nil, true))
	p.OnEvent(30, matchEnd(30))
	rows := feedFinal(p)
	if !titlesOf(t, rows[2])[ombv1.Title_KILL_STEAL] {
		t.Errorf("first achiever missing KILL_STEAL: %v", rows[2].Titles)
	}
	if titlesOf(t, rows[1])[ombv1.Title_KILL_STEAL] {
		t.Errorf("later tied robot awarded KILL_STEAL")
	}
}

// 11. AI_REGULAR — most AI rounds.
func TestTitleAiRegular(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, aiUsage(10, 4, 3))
	p.OnEvent(20, aiUsage(20, 4, 2)) // r4 total 5
	p.OnEvent(30, aiUsage(30, 1, 4))
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[4])[ombv1.Title_AI_REGULAR] {
		t.Errorf("robot 4 (5 rounds) missing AI_REGULAR; titles=%v", rows[4].Titles)
	}
	if titlesOf(t, rows[1])[ombv1.Title_AI_REGULAR] {
		t.Errorf("robot 1 (4 rounds) wrongly awarded AI_REGULAR")
	}
}

// 12. OLD_SCHOOL — zero AI rounds and zero snippet usage. Snippet usage is fed
// by real EvSnippetUsage telemetry (see snippet_titles_test.go); configuration
// alone never blocks the title.
func TestTitleOldSchool(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, aiUsage(10, 1, 2)) // r1 uses AI → disqualified
	p.OnEvent(20, core(20, 2, 10))   // r2 clean → qualifies
	p.OnEvent(30, kill(30, 3, 2, 0)) // r3 clean too (kills allowed)
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if titlesOf(t, rows[1])[ombv1.Title_OLD_SCHOOL] {
		t.Errorf("robot 1 (2 AI rounds) wrongly awarded OLD_SCHOOL")
	}
	if !titlesOf(t, rows[2])[ombv1.Title_OLD_SCHOOL] {
		t.Errorf("robot 2 missing OLD_SCHOOL; titles=%v", rows[2].Titles)
	}
	if !titlesOf(t, rows[3])[ombv1.Title_OLD_SCHOOL] {
		t.Errorf("robot 3 (clean, has kills) missing OLD_SCHOOL; titles=%v", rows[3].Titles)
	}
}

// 13. CNMB — most deaths.
func TestTitleCnmb(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, kill(10, 1, 2, 0))
	p.OnEvent(20, kill(20, 1, 2, 0)) // r2 died twice
	p.OnEvent(30, kill(30, 2, 3, 0)) // r3 died once
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[2])[ombv1.Title_CNMB] {
		t.Errorf("robot 2 (2 deaths) missing CNMB; titles=%v", rows[2].Titles)
	}
	if titlesOf(t, rows[3])[ombv1.Title_CNMB] {
		t.Errorf("robot 3 (1 death) wrongly awarded CNMB")
	}
}

// Tie-break: equal max counters → the robot reaching the max FIRST (lower
// tick) wins, regardless of robotID order.
func TestTitleTieBreakFirstAchiever(t *testing.T) {
	p := NewProjector()
	p.OnEvent(30, kill(30, 2, 1, 0)) // r2 reaches 1 kill at t30
	p.OnEvent(10, kill(10, 1, 3, 0)) // r1 reached 1 kill at t10 (fed later)
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_WAR_MACHINE] {
		t.Errorf("first achiever r1 (kill at t10) missing WAR_MACHINE; titles=%v", rows[1].Titles)
	}
	if titlesOf(t, rows[2])[ombv1.Title_WAR_MACHINE] {
		t.Errorf("later achiever r2 (kill at t30) wrongly won tie-break")
	}
}

// Tie-break on RUNNER: near-equal distances → earlier distance checkpoint wins.
func TestTitleRunnerTieBreak(t *testing.T) {
	p := NewProjector()
	p.OnCheckpoint(cp2(60, 1, 0, 0, 2, 0, 0))
	p.OnCheckpoint(cp2(120, 1, 7, 0, 2, 3, 0)) // r1 total 7 at t120
	p.OnCheckpoint(cp2(180, 1, 7, 0, 2, 3, 4)) // r2 reaches 7 only at t180
	p.OnEvent(200, matchEnd(200))
	rows := feedFinal(p)
	if !titlesOf(t, rows[1])[ombv1.Title_RUNNER] {
		t.Errorf("r1 (dist 7 first, t120) missing RUNNER; titles=%v", rows[1].Titles)
	}
}

// cp2 builds a checkpoint with two robots at the given positions.
func cp2(tick, id1 uint32, x1, y1 float64, id2 uint32, x2, y2 float64) sim.Checkpoint {
	return sim.Checkpoint{Tick: tick, Robots: []sim.Robot{robPos(id1, x1, y1), robPos(id2, x2, y2)}}
}
