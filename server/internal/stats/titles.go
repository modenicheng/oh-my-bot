package stats

import (
	"sort"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// distEps is the float tolerance for RUNNER comparisons (meters). Checkpoint
// distances are sums of square roots; exact ties are impractical to hit, so a
// small relative-ish epsilon only guards the engineered tie tests.
const distEps = 1e-9

// PEACEMAKER threshold: score >= 75th percentile of all players AND zero
// kills. Implemented as >= p75 rank (nearest-rank on descending scores), so a
// strict majority below — see titles_test.go for boundary evidence.
const (
	peaceMinPlayers = 2 // needs at least 2 players for a meaningful p75
)

// evaluateTitles applies the v0.3 §13 table to the accumulated state and
// returns per-robot title lists in enum order. sorted is robotID-ascending.
func (p *ProjectorImpl) evaluateTitles(sorted []*robotStats) map[uint32][]TitleID {
	titles := make(map[uint32][]TitleID, len(sorted))

	award := func(id uint32, t ombv1.Title) { titles[id] = append(titles[id], t) }

	// ---- Max-value titles: strictly greater than every rival wins; ties go
	// to the robot whose counter reached the max value first (lowest "*At"
	// tick; an equal tick keeps the earlier-sorted robot). A counter of 0 for
	// everyone awards nothing.
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.kills, r.killsAt },
		ombv1.Title_WAR_MACHINE, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.cores, r.coresAt },
		ombv1.Title_SCAVENGER, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.uplinks, r.uplinksAt },
		ombv1.Title_SIGNAL_THIEF, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.wallHits, r.wallHitsAt },
		ombv1.Title_WALL_HEAD, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.deaths, r.deathsAt },
		ombv1.Title_CNMB, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.aiRounds, r.aiRoundsAt },
		ombv1.Title_AI_REGULAR, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.scriptErrors, r.scriptErrorsAt },
		ombv1.Title_AI_IDIOT, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.hitsLanded, r.hitsAt },
		ombv1.Title_BARRAGE, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.killSteals, r.killStealsAt },
		ombv1.Title_KILL_STEAL, award)
	p.awardMax(sorted, func(r *robotStats) (int32, uint32) { return r.healedX10, r.healedAt },
		ombv1.Title_HEALER, award)

	// ---- RUNNER: max cumulative checkpoint distance, first achiever wins.
	p.awardMaxDist(sorted, ombv1.Title_RUNNER, award)

	// ---- SURVIVOR: max contiguous alive segment length, first achiever wins.
	p.awardMaxSortedUint(sorted, func(r *robotStats) (uint32, uint32) { return r.maxSurvTicks, r.maxSurvAt },
		ombv1.Title_SURVIVOR, award)

	// ---- PEACEMAKER: score >= p75 of all players, zero kills.
	p.awardPeacemaker(sorted, award)

	// ---- OLD_SCHOOL: zero AI rounds AND zero snippet uses, finished the
	// match (present at match end). Snippet use is fed by the real
	// EvSnippetUsage telemetry (a final output axis resolved to CS_SNIPPET),
	// so merely configuring snippets never blocks the title.
	for _, r := range sorted {
		if r.aiRounds == 0 && r.snippetUses == 0 {
			award(r.id, ombv1.Title_OLD_SCHOOL)
		}
	}

	return titles
}

// awardMax awards title to the unique maximum of value() when max > 0. Ties
// among max holders resolve to the earliest reachedAt tick; an exact tick tie
// keeps the first in sorted order (stable by robotID).
func (p *ProjectorImpl) awardMax(sorted []*robotStats, value func(*robotStats) (int32, uint32),
	title ombv1.Title, award func(uint32, ombv1.Title)) {
	if len(sorted) == 0 {
		return
	}
	best := sorted[0]
	bestVal, bestAt := value(best)
	for _, r := range sorted[1:] {
		v, at := value(r)
		if v > bestVal || (v == bestVal && at < bestAt) {
			best, bestVal, bestAt = r, v, at
		}
	}
	if bestVal > 0 {
		award(best.id, title)
	}
}

// awardMaxSortedUint is awardMax for uint32 metrics (SURVIVOR).
func (p *ProjectorImpl) awardMaxSortedUint(sorted []*robotStats, value func(*robotStats) (uint32, uint32),
	title ombv1.Title, award func(uint32, ombv1.Title)) {
	if len(sorted) == 0 {
		return
	}
	best := sorted[0]
	bestVal, bestAt := value(best)
	for _, r := range sorted[1:] {
		v, at := value(r)
		if v > bestVal || (v == bestVal && at < bestAt) {
			best, bestVal, bestAt = r, v, at
		}
	}
	if bestVal > 0 {
		award(best.id, title)
	}
}

// awardMaxDist awards RUNNER to the unique maximum distance when max > 0.
// Float distances tie within distEps: "first achiever" then means the robot
// whose distance last increased at the earlier checkpoint tick.
func (p *ProjectorImpl) awardMaxDist(sorted []*robotStats, title ombv1.Title, award func(uint32, ombv1.Title)) {
	if len(sorted) == 0 {
		return
	}
	best := sorted[0]
	bestVal, bestAt := best.dist, best.distAt
	for _, r := range sorted[1:] {
		if r.dist > bestVal+distEps || (r.dist > bestVal-distEps && r.distAt < bestAt) {
			best, bestVal, bestAt = r, r.dist, r.distAt
		}
	}
	if bestVal > distEps {
		award(best.id, title)
	}
}

// awardPeacemaker awards the title to every zero-kill player whose score is
// >= the nearest-rank 75th percentile of all scores (ascending: the smallest
// value with >= 75% of scores at or below it — so at most ~25% of the field
// sits strictly above the threshold). With < 2 players there is no meaningful
// percentile, so no award.
func (p *ProjectorImpl) awardPeacemaker(sorted []*robotStats, award func(uint32, ombv1.Title)) {
	if len(sorted) < peaceMinPlayers {
		return
	}
	scores := make([]int32, 0, len(sorted))
	for _, r := range sorted {
		scores = append(scores, r.score)
	}
	sort.Slice(scores, func(i, j int) bool { return scores[i] < scores[j] })
	rank := (75*len(scores) + 99) / 100 // ceil(0.75*n), ascending nearest-rank
	if rank < 1 {
		rank = 1
	}
	if rank > len(scores) {
		rank = len(scores)
	}
	threshold := scores[rank-1]
	for _, r := range sorted {
		if r.kills == 0 && r.score >= threshold {
			award(r.id, ombv1.Title_PEACEMAKER)
		}
	}
}
